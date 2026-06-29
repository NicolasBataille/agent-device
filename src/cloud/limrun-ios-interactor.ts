import type { Interactor, SnapshotOptions, SnapshotResult } from '../core/interactor-types.ts';
import {
  flattenIosTree,
  toIosSelector,
  writeBase64File,
  type IosTreeNode,
} from './limrun-snapshot.ts';
import type { LimrunIosSession } from './limrun-session.ts';
import { looksLikeUrl, resolveIosTarget, unsupported } from './limrun-utils.ts';

export class LimrunIosInteractor implements Interactor {
  private readonly session: LimrunIosSession;

  constructor(session: LimrunIosSession) {
    this.session = session;
  }

  async open(app: string, options?: { url?: string }): Promise<void> {
    if (options?.url) {
      await this.session.client.launchApp(app);
      await this.session.client.openUrl(options.url);
      return;
    }
    if (looksLikeUrl(app)) {
      await this.session.client.openUrl(app);
      return;
    }
    await this.session.client.launchApp(resolveIosTarget(app));
  }

  async openDevice(): Promise<void> {}

  async close(app: string): Promise<void> {
    if (app) await this.session.client.terminateApp(resolveIosTarget(app)).catch(() => {});
  }

  async tap(x: number, y: number): Promise<void> {
    await this.session.client.tap(x, y);
  }

  async tapElementSelector(selector: {
    key: 'id' | 'label' | 'text' | 'value';
    value: string;
  }): Promise<Record<string, unknown> | void> {
    await this.session.client.tapElement(toIosSelector(selector));
  }

  async doubleTap(x: number, y: number): Promise<void> {
    await this.tap(x, y);
    await this.tap(x, y);
  }

  async swipe(): Promise<never> {
    return unsupportedIos('swipe');
  }

  async pan(): Promise<never> {
    return unsupportedIos('pan');
  }

  async fling(): Promise<never> {
    return unsupportedIos('fling');
  }

  async longPress(): Promise<never> {
    return unsupportedIos('longpress', 'long press');
  }

  async focus(x: number, y: number): Promise<void> {
    await this.tap(x, y);
  }

  async type(text: string, delayMs?: number): Promise<void> {
    if (delayMs && delayMs > 0) {
      for (const char of Array.from(text)) {
        await this.session.client.typeText(char);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return;
    }
    await this.session.client.typeText(text);
  }

  async fill(x: number, y: number, text: string): Promise<void> {
    await this.tap(x, y);
    await this.session.client.typeText(text);
  }

  async fillElementSelector(
    selector: { key: 'id' | 'label' | 'text' | 'value'; value: string },
    text: string,
  ): Promise<void> {
    await this.session.client.setElementValue(text, toIosSelector(selector));
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right', options?: { pixels?: number }) {
    await this.session.client.scroll(direction, options?.pixels ?? 300);
  }

  async pinch(): Promise<never> {
    return unsupportedIos('pinch', 'multi-touch pinch');
  }

  async screenshot(outPath: string): Promise<void> {
    const screenshot = await this.session.client.screenshot();
    await writeBase64File(outPath, screenshot.base64);
  }

  async snapshot(_options?: SnapshotOptions): Promise<SnapshotResult> {
    const treeJson = await this.session.client.elementTree();
    const parsed = JSON.parse(treeJson) as IosTreeNode | IosTreeNode[];
    return { nodes: flattenIosTree(parsed), backend: 'xctest' };
  }

  async back(): Promise<void> {
    await this.session.client.pressKey('escape');
  }

  async home(): Promise<never> {
    return unsupportedIos('home');
  }

  async rotate(orientation: 'portrait' | 'landscape-left' | 'landscape-right'): Promise<void> {
    await this.session.client.setOrientation(orientation === 'portrait' ? 'Portrait' : 'Landscape');
  }

  async rotateGesture(): Promise<never> {
    return unsupportedIos('rotate', 'rotate gestures');
  }

  async transformGesture(): Promise<never> {
    return unsupportedIos('transform', 'transform gestures');
  }

  async appSwitcher(): Promise<never> {
    return unsupportedIos('app-switcher', 'app switcher');
  }

  async readClipboard(): Promise<never> {
    return unsupportedIos('clipboard', 'clipboard read');
  }

  async writeClipboard(): Promise<never> {
    return unsupportedIos('clipboard', 'clipboard write');
  }

  async setSetting(): Promise<never> {
    return unsupportedIos('settings', 'settings changes');
  }
}

function unsupportedIos(command: string, label = command): never {
  return unsupported(command, `Limrun iOS direct sessions do not expose ${label} yet.`);
}
