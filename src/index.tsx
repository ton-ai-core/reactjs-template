// Include Telegram UI styles first to allow our code override the package CSS.
import '@telegram-apps/telegram-ui/dist/styles.css';

import ReactDOM from 'react-dom/client';
import { StrictMode } from 'react';
import { retrieveLaunchParams } from '@telegram-apps/sdk-react';

import { Root } from '@/components/Root.tsx';
import { EnvUnsupported } from '@/components/EnvUnsupported.tsx';
import { init } from '@/init.ts';

import './index.css';

// Mock the environment in case, we are outside Telegram.
import './mockEnv.ts';

// Dev-only stack logger to prefix console output with top callsite.
if (import.meta.env.DEV) {
  await import('@ton-ai-core/devtrace')
    .then((m: typeof import('@ton-ai-core/devtrace')) => m.installStackLogger({ limit: 5, skip: 0, tail: false, ascending: true, mapSources: true, snippet: 1, preferApp: true, onlyApp: false }))
    .catch(() => {});

  await import('@ton-ai-core/devtrace')
    .then((m: typeof import('@ton-ai-core/devtrace')) => m.installDevInstrumentation())
    .catch(() => {});
}

const root = ReactDOM.createRoot(document.getElementById('root')!);

try {
  const launchParams = retrieveLaunchParams();
  const { tgWebAppPlatform: platform } = launchParams;
  const debug = (launchParams.tgWebAppStartParam || '').includes('platformer_debug')
    || import.meta.env.DEV;

  // Configure all application dependencies.
  await init({
    debug,
    eruda: debug && ['ios', 'android'].includes(platform),
    mockForMacOS: platform === 'macos',
  })
    .then(() => {
      root.render(
        <StrictMode>
          <Root/>
        </StrictMode>,
      );
    });
} catch (e) {
  root.render(<EnvUnsupported/>);
}
