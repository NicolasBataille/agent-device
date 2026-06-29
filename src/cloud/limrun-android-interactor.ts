import type { Interactor, SnapshotResult } from '../core/interactor-types.ts';
import type { AndroidAdbExecutorOptions } from '../platforms/android/adb-executor.ts';
import { ensureAndroidPortReverse, runLimrunAndroidAdb } from './limrun-android-adb.ts';
import { SETTINGS_INTENT, type LimrunAndroidSession } from './limrun-session.ts';
import { mapAndroidNode, toAndroidSelector, writeDataUriFile } from './limrun-snapshot.ts';
import {
  isAndroidSettingsTarget,
  looksLikeUrl,
  readLocalhostUrlPort,
  unsupported,
} from './limrun-utils.ts';

export class LimrunAndroidInteractor implements Interactor {
  private readonly session: LimrunAndroidSession;

  constructor(session: LimrunAndroidSession) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      await this.ensureReverseForUrl(options.url, 'launch-url');
      await this.runAdb([
        'shell',
        'monkey',
        '-p',
        app,
        '-c',
        'android.intent.category.LAUNCHER',
        '1',
      ]);
      await this.session.client.openUrl(options.url);
      return;
    }
    if (looksLikeUrl(app)) {
      await this.ensureReverseForUrl(app, 'open-url');
      await this.session.client.openUrl(app);
      return;
    }
    if (isAndroidSettingsTarget(app)) {
      await this.runAdb(['shell', 'am', 'start', '-W', '-a', SETTINGS_INTENT]);
      return;
    }
    await this.runAdb([
      'shell',
      'monkey',
      '-p',
      app,
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.runAdb(['shell', 'am', 'force-stop', app], { allowFailure: true });
  }

  async tap(x: number, y: number): Promise<void> {
    await this.session.client.tap({ x, y });
  }

  async tapElementSelector(selector: {
    key: 'id' | 'label' | 'text' | 'value';
    value: string;
  }): Promise<void> {
    await this.session.client.tap({ selector: toAndroidSelector(selector) });
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await this.tap(x, y);
  }

  async swipe(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.runAdb([
      'shell',
      'input',
      'swipe',
      String(Math.round(x1)),
      String(Math.round(y1)),
      String(Math.round(x2)),
      String(Math.round(y2)),
      String(durationMs ?? 300),
    ]);
  }

  async pan(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.swipe(x1, y1, x2, y2, durationMs);
  }

  async fling(x1: number, y1: number, x2: number, y2: number, durationMs?: number) {
    await this.swipe(x1, y1, x2, y2, durationMs);
  }

  async longPress(x: number, y: number, durationMs?: number) {
    await this.swipe(x, y, x, y, durationMs ?? 800);
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  async type(text: string): Promise<void> {
    await this.session.client.setText(undefined, text);
  }

  async fill(x: number, y: number, text: string): Promise<void> {
    await this.session.client.setText({ x, y }, text);
  }

  async fillElementSelector(
    selector: { key: 'id' | 'label' | 'text' | 'value'; value: string },
    text: string,
  ): Promise<void> {
    await this.session.client.setText({ selector: toAndroidSelector(selector) }, text);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', options?: { pixels?: number }) {
    await this.session.client.scrollScreen(direction, options?.pixels);
  }

  async pinch(): Promise<never> {
    return unsupportedAndroid('pinch');
  }

  async screenshot(outPath: string): Promise<void> {
    const screenshot = await this.session.client.screenshot();
    await writeDataUriFile(outPath, screenshot.dataUri);
  }

  async snapshot(): Promise<SnapshotResult> {
    const tree = await this.session.client.getElementTree();
    return {
      nodes: tree.nodes.map(mapAndroidNode),
      ...readOptionalTruncation(tree),
      backend: 'android',
    };
  }

  async back(): Promise<void> {
    await this.session.client.pressKey('BACK');
  }

  async home(): Promise<void> {
    await this.session.client.pressKey('HOME');
  }

  async rotate(): Promise<never> {
    return unsupportedAndroid('rotate');
  }

  async rotateGesture(): Promise<never> {
    return unsupportedAndroid('rotate', 'rotate gestures');
  }

  async transformGesture(): Promise<never> {
    return unsupportedAndroid('transform', 'transform gestures');
  }

  async appSwitcher(): Promise<void> {
    await this.session.client.pressKey('APP_SWITCH');
  }

  async readClipboard(): Promise<never> {
    return unsupportedAndroid('clipboard', 'clipboard read');
  }

  async writeClipboard(): Promise<never> {
    return unsupportedAndroid('clipboard', 'clipboard write');
  }

  async setSetting(): Promise<never> {
    return unsupportedAndroid('settings', 'settings changes');
  }

  private async runAdb(args: string[], options?: AndroidAdbExecutorOptions): Promise<void> {
    await runLimrunAndroidAdb(this.session, args, options);
  }

  private async ensureReverseForUrl(url: string, name: string): Promise<void> {
    const port = readLocalhostUrlPort(url);
    if (!port) return;
    await ensureAndroidPortReverse(this.session, {
      devicePort: port,
      hostPort: port,
      name,
    });
  }
}

function readOptionalTruncation(value: unknown): Pick<SnapshotResult, 'truncated'> {
  const truncated =
    value && typeof value === 'object' && 'truncated' in value
      ? (value as { truncated?: unknown }).truncated
      : undefined;
  return typeof truncated === 'boolean' ? { truncated } : {};
}

function unsupportedAndroid(command: string, label = command): never {
  return unsupported(command, `Limrun Android direct sessions do not expose ${label} yet.`);
}
