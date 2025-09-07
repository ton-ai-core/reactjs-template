module.exports = function ({ types: t }) {
  function isFunc(path) {
    return path && (
      path.isFunctionDeclaration() ||
      path.isFunctionExpression() ||
      path.isArrowFunctionExpression() ||
      path.isClassMethod() ||
      path.isObjectMethod()
    );
  }

  function collectIds(node, acc) {
    if (!node) return;
    if (t.isIdentifier(node)) acc.add(node.name);
    else if (t.isAssignmentPattern(node)) collectIds(node.left, acc);
    else if (t.isRestElement(node)) collectIds(node.argument, acc);
    else if (t.isObjectProperty(node)) collectIds(node.value, acc);
    else if (t.isObjectPattern(node)) node.properties.forEach(p => collectIds(p, acc));
    else if (t.isArrayPattern(node)) node.elements.forEach(e => e && collectIds(e, acc));
  }

  function guessName(path) {
    const n = path.node;
    if (t.isFunctionDeclaration(n) && n.id) return n.id.name;
    if ((t.isFunctionExpression(n) || t.isArrowFunctionExpression(n)) && path.parentPath && path.parentPath.isVariableDeclarator()) {
      const id = path.parentPath.node.id;
      if (t.isIdentifier(id)) return id.name;
    }
    if ((t.isClassMethod(n) || t.isObjectMethod(n)) && t.isIdentifier(n.key)) return n.key.name;
    return '(anon)';
  }

  function relFile(state) {
    const f = state.filename || '';
    const idx = f.lastIndexOf('/src/');
    if (idx >= 0) return f.slice(idx + 1);
    const parts = f.split(/[\\/]/);
    return parts[parts.length - 1] || f;
  }

  function ensureImportTRACE(filePath) {
    const file = filePath.hub && filePath.hub.file;
    if (file && file.get && file.get('__TRACE_IMPORTED')) return;
    // Check existing imports in Program body to avoid duplicates
    const bodyPaths = filePath.get('body') || [];
    const hasImport = bodyPaths.some(p => p.isImportDeclaration() &&
      p.node.source && p.node.source.value === '@/trace-context' &&
      p.node.specifiers && p.node.specifiers.some(s => t.isImportSpecifier(s) && s.imported && s.imported.name === '__TRACE'));
    if (!hasImport) {
      filePath.unshiftContainer('body',
        t.importDeclaration(
          [t.importSpecifier(t.identifier('__TRACE'), t.identifier('__TRACE'))],
          t.stringLiteral('@/trace-context')
        )
      );
    }
    if (file && file.set) file.set('__TRACE_IMPORTED', true);
  }

  function ensureImportDBG(filePath) {
    const bodyPaths = filePath.get('body') || [];
    const hasImport = bodyPaths.some(p => p.isImportDeclaration() &&
      p.node.source && p.node.source.value === '@/devtools/dbg' &&
      p.node.specifiers && p.node.specifiers.some(s => t.isImportSpecifier(s) && t.isIdentifier(s.imported, { name: 'dbg' })));
    if (!hasImport) {
      filePath.unshiftContainer('body',
        t.importDeclaration(
          [t.importSpecifier(t.identifier('dbg'), t.identifier('dbg'))],
          t.stringLiteral('@/devtools/dbg')
        )
      );
    }
  }

  function isConsoleCall(path) {
    const cal = path.node.callee;
    return t.isMemberExpression(cal) && t.isIdentifier(cal.object, { name: 'console' }) &&
      t.isIdentifier(cal.property) && ['log','info','warn','error','debug'].includes(cal.property.name);
  }

  function isDescendantScope(scope, root) {
    let s = scope;
    while (s) {
      if (s === root) return true;
      s = s.parent;
    }
    return false;
  }

  function collectLocalsForCall(path) {
    const func = path.getFunctionParent();
    const funcScope = func ? func.scope : null;
    const all = path.scope.getAllBindings();
    const picked = [];
    for (const [name, binding] of Object.entries(all)) {
      if (name === 'console' || name === '__TRACE') continue;
      if (binding.kind === 'module') continue; // imports
      if (funcScope && !isDescendantScope(binding.scope, funcScope)) continue; // outside current function
      // basic hygiene: skip names that look internal
      if (name.startsWith('__')) continue;
      picked.push(name);
    }
    // Limit count to avoid huge payloads
    return picked.slice(0, 10);
  }

  function wrap(path, state) {
    if (!isFunc(path)) return;

    const id = guessName(path);
    const loc = path.node.loc?.start || { line: 0, column: 0 };
    const file = relFile(state);
    const col1 = (loc.column || 0) + 1;

    // Collect parameter identifiers (safe for arrows; no arguments usage)
    const names = new Set();
    (path.node.params || []).forEach(p => collectIds(p, names));
    const props = Array.from(names).map(n => t.objectProperty(t.stringLiteral(n), t.identifier(n)));
    const argsObj = t.objectExpression(props);

    const filePath = path.hub.file.path;
    ensureImportTRACE(filePath);

    const frameDecl = t.variableDeclaration('const', [
      t.variableDeclarator(
        t.identifier('__frame'),
        t.callExpression(
          t.memberExpression(t.identifier('__TRACE'), t.identifier('enter')),
          [t.objectExpression([
            t.objectProperty(t.identifier('fn'), t.stringLiteral(id)),
            t.objectProperty(t.identifier('file'), t.stringLiteral(file)),
            t.objectProperty(t.identifier('line'), t.numericLiteral(loc.line || 0)),
            t.objectProperty(t.identifier('col'), t.numericLiteral(col1)),
            t.objectProperty(t.identifier('args'), argsObj),
          ])]
        )
      )
    ]);

    const body = path.get('body');
    const block = body.isBlockStatement() ? body.node : t.blockStatement([t.returnStatement(body.node)]);
    const wrapped = t.blockStatement([
      frameDecl,
      t.tryStatement(
        block,
        null,
        t.blockStatement([
          t.expressionStatement(
            t.callExpression(
              t.memberExpression(t.identifier('__TRACE'), t.identifier('leave')),
              [t.identifier('__frame')]
            )
          )
        ])
      )
    ]);
    body.replaceWith(wrapped);
  }

  return {
    name: 'function-frames',
    visitor: {
      FunctionDeclaration(path, state) { wrap(path, state); },
      FunctionExpression(path, state) { wrap(path, state); },
      ArrowFunctionExpression(path, state) { wrap(path, state); },
      ClassMethod(path, state) { wrap(path, state); },
      ObjectMethod(path, state) { wrap(path, state); },
      CallExpression(path) {
        if (!isConsoleCall(path)) return;
        // If already contains dbg(...) arg, skip
        const hasDbg = path.node.arguments.some(arg => t.isCallExpression(arg) && t.isIdentifier(arg.callee, { name: 'dbg' }));
        if (hasDbg) return;
        const names = collectLocalsForCall(path);
        if (!names.length) return;
        // Build object literal { a, b, c }
        const props = names.map(n => t.objectProperty(t.stringLiteral(n), t.identifier(n)));
        const obj = t.objectExpression(props);
        const dbgCall = t.callExpression(t.identifier('dbg'), [obj]);
        // Append as last argument to keep formatting/%c mapping intact
        path.node.arguments.push(dbgCall);
        // Ensure dbg import exists once
        ensureImportDBG(path.hub.file.path);
      }
    }
  };
};
