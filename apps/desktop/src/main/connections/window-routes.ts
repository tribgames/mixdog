/** The part of a webContents a route needs. */
export interface RoutableWebContents {
  readonly id: number;
  once(event: 'destroyed', listener: () => void): unknown;
}

/** webContents.id → connection id, filled when a window is created and
 *  dropped when its webContents is destroyed. */
export class WindowRouteRegistry {
  private readonly routes = new Map<number, string>();

  register(webContents: RoutableWebContents, connectionId: string): void {
    const { id } = webContents;
    const current = this.routes.get(id);
    if (current !== undefined && current !== connectionId) {
      throw new Error(`Window ${id} already drives connection "${current}".`);
    }
    this.routes.set(id, connectionId);
    webContents.once('destroyed', () => {
      if (this.routes.get(id) === connectionId) this.routes.delete(id);
    });
  }

  connectionIdFor(webContentsId: number): string | undefined {
    return this.routes.get(webContentsId);
  }

  has(webContentsId: number): boolean {
    return this.routes.has(webContentsId);
  }

  webContentsIdsFor(connectionId: string): number[] {
    const ids: number[] = [];
    for (const [id, routed] of this.routes) if (routed === connectionId) ids.push(id);
    return ids;
  }
}
