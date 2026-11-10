// Empty-transcript header: the block-letter logo plus the version/cwd line.
import { Box, Text } from 'ink';
import { theme, surfaceBackground } from '../../theme.mjs';
import { centerLine } from '../app-format.mjs';
import { localPackageVersion } from '../../../runtime/shared/update-checker.mjs';

const LOGO_ROWS = [
  ['███╗   ███╗██╗██╗  ██╗██████╗  ██████╗  ██████╗ ', false],
  ['████╗ ████║██║╚██╗██╔╝██╔══██╗██╔═══██╗██╔════╝ ', false],
  ['██╔████╔██║██║ ╚███╔╝ ██║  ██║██║   ██║██║  ███╗', true],
  ['██║╚██╔╝██║██║ ██╔██╗ ██║  ██║██║   ██║██║   ██║', true],
  ['██║ ╚═╝ ██║██║██╔╝ ██╗██████╔╝╚██████╔╝╚██████╔╝', true],
];

export function renderWelcomeBanner({ frameColumns, cwd }) {
  return (
    <Box
      flexDirection="column"
      height={7}
      flexShrink={0}
      marginTop={3}
      marginBottom={1}
      backgroundColor={surfaceBackground()}
    >
      {LOGO_ROWS.map(([line, accent]) => (
        <Text key={line} color={accent ? (theme.logo ?? theme.claude) : theme.text} bold>
          {centerLine(line, frameColumns)}
        </Text>
      ))}
      <Box height={1} flexShrink={0} />
      <Text color={theme.inactive}>
        {centerLine(`mixdog coding agent · v${localPackageVersion()} · ${cwd}`, frameColumns, 4)}
      </Text>
    </Box>
  );
}
