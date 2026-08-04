import { type Styles } from './styles.js';
export declare const sliceTextByDisplayWidthWithPolicy: (line: string, from: number, to: number, wide: boolean) => string;
export declare const sliceTextByDisplayWidth: (line: string, from: number, to: number) => string;
declare const wrapText: (text: string, maxWidth: number, wrapType: Styles["textWrap"]) => string;
export default wrapText;
