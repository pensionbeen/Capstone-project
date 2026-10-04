export type FolderResult =
  | { status: 'selected'; name: string; path: string }
  | { status: 'cancelled' }
  | { status: 'error'; message: string };

export interface DesktopBridge {
  selectProjectFolder: () => Promise<FolderResult>;
}
