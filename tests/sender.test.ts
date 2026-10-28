import { describe, expect, it } from 'vitest';
import { isAllowed } from '../src/background/router';
import { classifySender } from '../src/background/sender';
import { RequestSchema, type RequestType } from '../src/shared/messages';
import { isBuiltinOrigin } from '../src/shared/sites';

const ID = 'abcdefghijklmnopabcdefghijklmnop';
const EXT = `chrome-extension://${ID}`;
const tab = { id: 1 };

describe('classifySender', () => {
  it('accepts the popup and offscreen document', () => {
    expect(classifySender({ id: ID, url: `${EXT}/popup.html` }, ID, isBuiltinOrigin)).toBe(
      'extension-page',
    );
  });

  it('treats the onboarding tab as an extension page', () => {
    expect(
      classifySender(
        { id: ID, tab, frameId: 0, url: `${EXT}/onboarding.html` },
        ID,
        isBuiltinOrigin,
      ),
    ).toBe('extension-page');
  });

  it('treats an embedded extension iframe as extension-frame', () => {
    expect(
      classifySender({ id: ID, tab, frameId: 7, url: `${EXT}/unlock.html` }, ID, isBuiltinOrigin),
    ).toBe('extension-frame');
  });

  it('accepts a top-frame content script on a built-in site', () => {
    expect(
      classifySender(
        {
          id: ID,
          tab,
          frameId: 0,
          origin: 'https://gmgn.ai',
          url: 'https://gmgn.ai/base/token/0x1',
        },
        ID,
        isBuiltinOrigin,
      ),
    ).toBe('content-script');
  });

  it.each([
    ['other extension', { id: 'other', tab, frameId: 0, origin: 'https://gmgn.ai' }],
    ['missing id', { tab, frameId: 0, origin: 'https://gmgn.ai' }],
    ['sub-frame', { id: ID, tab, frameId: 3, origin: 'https://gmgn.ai' }],
    ['unlisted origin', { id: ID, tab, frameId: 0, origin: 'https://evil.example' }],
    ['look-alike origin', { id: ID, tab, frameId: 0, origin: 'https://gmgn.ai.evil.example' }],
    ['http origin', { id: ID, tab, frameId: 0, origin: 'http://gmgn.ai' }],
    ['foreign extension page', { id: ID, url: 'chrome-extension://other/popup.html' }],
  ])('rejects %s', (_label, sender) => {
    expect(classifySender(sender, ID, isBuiltinOrigin)).toBeNull();
  });
});

describe('RequestSchema', () => {
  it('accepts known requests', () => {
    expect(RequestSchema.safeParse({ type: 'ping' }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'vault.unlock', password: 'x' }).success).toBe(true);
  });

  it.each([
    null,
    'ping',
    {},
    { type: 'exportKey' },
    { type: 'ping', extra: 1 },
    { type: ['ping'] },
    { type: 'vault.reset', confirm: 'yes' },
    { type: 'wallets.exportKey', id: 'a' },
    { type: 'settings.update', patch: { autoLockMinutes: 0 } },
    { type: 'settings.update', patch: { unknownKey: 1 } },
  ])('rejects %j', (input) => {
    expect(RequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('isAllowed', () => {
  const SENSITIVE: RequestType[] = [
    'vault.create',
    'vault.reset',
    'wallets.exportKey',
    'wallets.importKey',
    'wallets.remove',
    'settings.update',
    'send.prepare',
    'send.checkRecipient',
    'send.execute',
  ];

  it.each(SENSITIVE)('content scripts cannot call %s', (type) => {
    expect(isAllowed('content-script', type)).toBe(false);
    expect(isAllowed('extension-frame', type)).toBe(false);
    expect(isAllowed('extension-page', type)).toBe(true);
  });

  it('content scripts may keep RPC connections warm', () => {
    expect(isAllowed('content-script', 'rpc.warm')).toBe(true);
    expect(RequestSchema.safeParse({ type: 'rpc.warm', chainId: 4663 }).success).toBe(true);
    expect(RequestSchema.safeParse({ type: 'rpc.warm', chainId: 4663, url: 'x' }).success).toBe(
      false,
    );
  });

  it('content scripts cannot unlock (password must not be typed into a page)', () => {
    expect(isAllowed('content-script', 'vault.unlock')).toBe(false);
    expect(isAllowed('extension-frame', 'vault.unlock')).toBe(true);
  });
});
