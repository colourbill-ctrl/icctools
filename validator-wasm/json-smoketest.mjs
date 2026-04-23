import createIccJsonModule from './build/iccjson.mjs';
import createIccModule     from './build/iccprofiledump.mjs';
import { readFileSync }    from 'node:fs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node json-smoketest.mjs <profile.icc>');
  process.exit(1);
}

const bytes = new Uint8Array(readFileSync(profilePath));
console.log('Loaded profile:', profilePath, '(' + bytes.length + ' bytes)');

const jmod = await createIccJsonModule();
console.log('1. iccToJson…');
const jsonStr = jmod.iccToJson(bytes, 2, false);
console.log('   JSON length:', jsonStr.length, 'chars');
console.log('   preview:', jsonStr.slice(0, 140).replace(/\s+/g, ' '));

console.log('2. jsonToIcc…');
let newBytes;
try {
  newBytes = jmod.jsonToIcc(jsonStr);
} catch (e) {
  const msg = jmod.getExceptionMessage ? jmod.getExceptionMessage(e) : String(e);
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
