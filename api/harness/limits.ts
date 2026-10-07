/**
 * What a package may be, in one place: the checks enforce these numbers on
 * upload and import, and GET /config hands the same numbers to clients, so
 * Codeg checks a package against them again before installing it.
 */
export const LIMITS = {
  /** a zip as uploaded */
  zipBytes: 10 * 1024 * 1024,
  /** all files, unpacked */
  totalBytes: 30 * 1024 * 1024,
  files: 500,
  fileBytes: 5 * 1024 * 1024,
  /** directory levels below the package root */
  depth: 10,
  /** bytes of a path, UTF-8 */
  pathBytes: 512,
  /** a file over `minBytes` that unpacks to more than `ratio` times its packed size is refused */
  compression: { minBytes: 1024 * 1024, ratio: 100 },
  /** the body of a prompt or an assistant */
  textBytes: 100 * 1024,
  /** SKILL.md's description, in characters */
  descriptionChars: 1024,
} as const;

/** Licenses that let us keep and hand out copies of the files (SPDX ids). */
export const REDISTRIBUTABLE = new Set([
  '0BSD', 'AFL-3.0', 'AGPL-3.0', 'AGPL-3.0-only', 'AGPL-3.0-or-later', 'Apache-2.0', 'Artistic-2.0', 'BSD-2-Clause',
  'BSD-3-Clause', 'BSL-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'CC0-1.0', 'EPL-2.0', 'GPL-2.0', 'GPL-2.0-only',
  'GPL-2.0-or-later', 'GPL-3.0', 'GPL-3.0-only', 'GPL-3.0-or-later', 'ISC', 'LGPL-2.1', 'LGPL-2.1-only',
  'LGPL-2.1-or-later', 'LGPL-3.0', 'LGPL-3.0-only', 'LGPL-3.0-or-later', 'MIT', 'MIT-0', 'MPL-2.0', 'Python-2.0',
  'Unlicense', 'Zlib',
]);

/** The SPDX id for a license name as authors write it ('apache 2.0' → 'Apache-2.0'), or null. */
export function spdx(name: string | null | undefined): string | null {
  if (!name) return null;
  const t = name.trim();
  for (const id of REDISTRIBUTABLE) if (id.toLowerCase() === t.toLowerCase()) return id;
  const k = t.toLowerCase().replace(/[^a-z0-9.]+/g, ' ').trim();
  const known: [RegExp, string][] = [
    [/^mit( license)?$/, 'MIT'],
    [/^apache( license)?( version)? 2(\.0)?$/, 'Apache-2.0'],
    [/^bsd 3 clause|^bsd 3$|^new bsd/, 'BSD-3-Clause'],
    [/^bsd 2 clause|^simplified bsd/, 'BSD-2-Clause'],
    [/^isc( license)?$/, 'ISC'],
    [/^mpl 2(\.0)?$|^mozilla public license 2(\.0)?$/, 'MPL-2.0'],
    [/^gpl ?v?3|^gnu general public license v?3/, 'GPL-3.0'],
    [/^agpl ?v?3/, 'AGPL-3.0'],
    [/^cc0|^cc 0/, 'CC0-1.0'],
    [/^unlicense|^the unlicense/, 'Unlicense'],
  ];
  for (const [re, id] of known) if (re.test(k)) return id;
  return null;
}

/** Name a license file's text by the well-known licenses' wording, or null. */
export function licenseFromText(text: string): string | null {
  const t = text.slice(0, 4000).replace(/\s+/g, ' ');
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(t)) return 'MIT';
  if (/Apache License,? Version 2\.0/i.test(t)) return 'Apache-2.0';
  if (/Redistribution and use in source and binary forms/i.test(t)) {
    return /Neither the name/i.test(t) ? 'BSD-3-Clause' : 'BSD-2-Clause';
  }
  if (/Permission to use, copy, modify, and\/or distribute this software for any purpose/i.test(t)) return 'ISC';
  if (/Mozilla Public License,? (Version|v\.?) 2\.0/i.test(t)) return 'MPL-2.0';
  if (/GNU AFFERO GENERAL PUBLIC LICENSE\s*Version 3/i.test(t)) return 'AGPL-3.0';
  if (/GNU LESSER GENERAL PUBLIC LICENSE/i.test(t)) return /Version 3/i.test(t) ? 'LGPL-3.0' : 'LGPL-2.1';
  if (/GNU GENERAL PUBLIC LICENSE\s*Version 3/i.test(t)) return 'GPL-3.0';
  if (/GNU GENERAL PUBLIC LICENSE\s*Version 2/i.test(t)) return 'GPL-2.0';
  if (/This is free and unencumbered software released into the public domain/i.test(t)) return 'Unlicense';
  if (/CC0 1\.0 Universal/i.test(t)) return 'CC0-1.0';
  if (/Attribution-ShareAlike 4\.0 International/i.test(t)) return 'CC-BY-SA-4.0';
  if (/Attribution 4\.0 International/i.test(t)) return 'CC-BY-4.0';
  return null;
}
