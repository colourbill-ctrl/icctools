import createIccXmlModule from './build/iccxml.mjs';
import createIccModule    from './build/iccprofiledump.mjs';
import { readFileSync } from 'node:fs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node xml-smoketest.mjs <profile.icc>');
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(profilePath));
console.log('Loaded profile:', profilePath, '(' + bytes.length + ' bytes)');

const xmlMod = await createIccXmlModule();
console.log('1. iccToXml…');
const xml = xmlMod.iccToXml(bytes);
console.log('   XML length:', xml.length, 'chars');
console.log('   preview:', xml.slice(0, 120).replace(/\n/g, ' '));

console.log('2. xmlToIcc…');
let newBytes;
try {
  newBytes = xmlMod.xmlToIcc(xml);
} catch (e) {
  const msg = xmlMod.getExceptionMessage ? xmlMod.getExceptionMessage(e) : String(e);
  console.error('   FAILED:', msg);
  process.exit(1);
}
console.log('   out bytes:', newBytes.length);

console.log('3. re-validate…');
const vmod = await createIccModule();
const json = vmod.validateProfile(newBytes);
const parsed = JSON.parse(json);
console.log('   profileId :', parsed.profileId);
console.log('   validation:', parsed.validation?.level, '-', parsed.validation?.status);
console.log('   tag count :', parsed.tags?.length);
