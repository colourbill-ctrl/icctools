import createIccModule from './build/iccprofiledump.mjs';
import { readFileSync } from 'node:fs';

const profilePath = process.argv[2];
if (!profilePath) {
  console.error('Usage: node smoketest.mjs <profile.icc>');
  process.exit(1);
}

const bytes = readFileSync(profilePath);
const mod = await createIccModule();
const json = mod.validateProfile(new Uint8Array(bytes));
const parsed = JSON.parse(json);

console.log('Library  :', parsed.libraryVersion);
console.log('Profile  :', parsed.profileId);
console.log('Size     :', parsed.sizeBytes);
console.log('Version  :', parsed.header?.Version);
console.log('Class    :', parsed.header?.['Profile Class']);
console.log('Tags     :', parsed.tags?.length);
console.log('Validate :', parsed.validation?.level, '-', parsed.validation?.status);
if (parsed.tags?.length) {
  const t = parsed.tags[0];
  console.log('Tag[0]   :', t.name, '(' + t.id + ')', '—', t.type);
  console.log('Desc len :', (t.description || '').length, 'chars');
}
