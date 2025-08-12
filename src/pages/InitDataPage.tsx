import { type FC, type ReactNode, useMemo } from 'react';
import {
  initDataRaw as _initDataRaw,
  initDataState as _initDataState,
  type User,
  useSignal,
} from '@telegram-apps/sdk-react';
import { List, Placeholder } from '@telegram-apps/telegram-ui';

import { DisplayData, type DisplayDataRow } from '@/components/DisplayData/DisplayData.tsx';
import { Page } from '@/components/Page.tsx';
import { isRecord } from '@/css/classnames.ts';

function toDisplayValue(value: unknown): ReactNode | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value === null || value === undefined) {
    return undefined;
  }
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return value as string | number | boolean;
  }
  return undefined;
}

function getUserRows(user: User): DisplayDataRow[] {
  const entries = Object.entries(user as unknown as Record<string, unknown>);
  return entries.map(([title, value]) => ({ title, value: toDisplayValue(value) }));
}

export const InitDataPage: FC = () => {
  const initDataRaw = useSignal(_initDataRaw);
  const initDataState = useSignal(_initDataState);

  const initDataRows = useMemo<DisplayDataRow[] | undefined>(() => {
    if (!initDataState || !initDataRaw) {
      return;
    }
    return [
      { title: 'raw', value: initDataRaw },
      ...Object.entries(initDataState as unknown as Record<string, unknown>)
        .reduce<DisplayDataRow[]>((acc, [title, value]) => {
          const v = toDisplayValue(value);
          if (v !== undefined || !value || typeof value !== 'object') {
            acc.push({ title, value: v });
          }
          return acc;
        }, []),
    ];
  }, [initDataState, initDataRaw]);

  const userRows = useMemo<DisplayDataRow[] | undefined>(() => {
    return initDataState && initDataState.user
      ? getUserRows(initDataState.user)
      : undefined;
  }, [initDataState]);

  const receiverRows = useMemo<DisplayDataRow[] | undefined>(() => {
    return initDataState && initDataState.receiver
      ? getUserRows(initDataState.receiver)
      : undefined;
  }, [initDataState]);

  const chatRows = useMemo<DisplayDataRow[] | undefined>(() => {
    const chatObject = (() : Record<string, unknown> | undefined => {
      if (!isRecord(initDataState)) {
        return undefined;
      }
      const candidate = (initDataState as Record<string, unknown>)['chat'];
      if (isRecord(candidate)) {
        return candidate;
      }
      return undefined;
    })();
    return chatObject
      ? Object.entries(chatObject).map(([title, value]) => ({ title, value: toDisplayValue(value) }))
      : undefined;
  }, [initDataState]);

  if (!initDataRows) {
    return (
      <Page>
        <Placeholder
          header="Oops"
          description="Application was launched with missing init data"
        >
          <img
            alt="Telegram sticker"
            src="https://xelene.me/telegram.gif"
            style={{ display: 'block', width: '144px', height: '144px' }}
          />
        </Placeholder>
      </Page>
    );
  }
  return (
    <Page>
      <List>
        <DisplayData header={'Init Data'} rows={initDataRows}/>
        {userRows && <DisplayData header={'User'} rows={userRows}/>}
        {receiverRows && <DisplayData header={'Receiver'} rows={receiverRows}/>}
        {chatRows && <DisplayData header={'Chat'} rows={chatRows}/>}
      </List>
    </Page>
  );
};
