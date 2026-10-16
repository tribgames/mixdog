export function canonicalPath(value: string): string;
export function pathKey(value: string, platform?: string): string;
export function samePath(left: string, right: string): boolean;
export function isWithin(parent: string, child: string): boolean;
export function projectSubdirOf(topLevel?: string | null, projectPath?: string | null): string;
export function checkoutFolder(root: string, subdir?: string): string;
