export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// [Определения]
export type ClassPrimitive = string | null | undefined | false;
interface ClassDictionary {
  [key: string]: ClassValue;
}
type ClassArray = ClassValue[];
export type ClassValue = ClassPrimitive | ClassArray | ClassDictionary;

/**
 * Function which joins passed values with space following these rules:
 * 1. If value is non-empty string, it will be added to output.
 * 2. If value is object, only those keys will be added, which values are truthy.
 * 3. If value is array, classNames will be called with this value spread.
 * 4. All other values are ignored.
 *
 * You can find this function to similar one from the package {@link https://www.npmjs.com/package/classnames|classnames}.
 * @param values - values array.
 * @returns Final class name.
 */
export function classNames(...values: ClassValue[]): string {
  return values
    .map((value) => {
      if (typeof value === 'string') {
        return value;
      }

      if (isRecord(value)) {
        return classNames(
          Object.entries(value as Record<string, ClassValue>).map(([key, v]) => (v ? key : '')),
        );
      }

      if (Array.isArray(value)) {
        return classNames(...(value as ClassValue[]));
      }

      return '';
    })
    .filter(Boolean)
    .join(' ');
}

// [Инварианты]: keys объединяемых объектов — строковые, значения — совместимы с ClassValue
type UnionStringKeys<U> = U extends U
  ? { [K in keyof U]-?: U[K] extends string | undefined ? K : never }[keyof U]
  : never;

type UnionRequiredKeys<U> = U extends U
  ? { [K in UnionStringKeys<U>]: (object extends Pick<U, K> ? never : K) }[UnionStringKeys<U>]
  : never;

type UnionOptionalKeys<U> = Exclude<UnionStringKeys<U>, UnionRequiredKeys<U>>;

export type MergeClassNames<Tuple extends readonly unknown[]> =
  Exclude<Tuple[number], number | string | null | undefined | readonly unknown[] | boolean> extends infer Union
    ? (& { [K in UnionRequiredKeys<Union>]: string } & { [K in UnionOptionalKeys<Union>]?: string })
    : never;

/**
 * Merges two sets of classnames.
 *
 * The function expects to pass an array of objects with values that could be passed to
 * the `classNames` function.
 * @returns An object with keys from all objects with merged values.
 * @see classNames
 */
export function mergeClassNames<T extends readonly Record<string, ClassValue | undefined>[]>(
  ...partials: T
): MergeClassNames<T> {
  return partials.reduce<MergeClassNames<T>>((acc, partial) => {
    if (isRecord(partial)) {
      Object.entries(partial).forEach(([key, value]) => {
        const accRecord: Record<string, string | undefined> = acc as unknown as Record<string, string | undefined>;
        const className = classNames(accRecord[key], value);
        if (className) {
          accRecord[key] = className;
        }
      });
    }
    return acc;
  }, {} as MergeClassNames<T>);
}