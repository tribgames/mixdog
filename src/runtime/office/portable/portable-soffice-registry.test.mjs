import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { registrySofficePrograms } from './portable-soffice.mjs';

test('reg query output names the soffice.com of the recorded install folder, in any UI language', () => {
  const english = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (Default)    REG_SZ    D:\\Apps\\LibreOffice 24\\program\r\n\r\n';
  const korean = 'HKEY_CURRENT_USER\\SOFTWARE\\LibreOffice\\UNO\\InstallPath\r\n    (기본값)    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program\r\n';
  assert.deepEqual(registrySofficePrograms(english), [join('D:\\Apps\\LibreOffice 24\\program', 'soffice.com')]);
  assert.deepEqual(registrySofficePrograms(korean), [
    join('C:\\Users\\me\\AppData\\Local\\Programs\\LibreOffice\\program', 'soffice.com'),
  ]);
  assert.deepEqual(registrySofficePrograms(''), []);
  assert.deepEqual(registrySofficePrograms('ERROR: The system was unable to find the specified registry key or value.'), []);
});
