import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { MemorySection, MemorySymbol } from './types';
export interface HexPage {
  symbolId: string; name: string; section: string; address: number; loadAddress?: number;
  total: number; offset: number; bytes: number[]; storage: 'elf' | 'nobits';
}
interface ElfSection { name: string; type: number; flags: number; address: number; offset: number; size: number; }
const PAGE_BYTES = 256;
/** File-only viewer. Never reads the probe or fills NOBITS with invented zeros. */
export class ElfByteReader {
  private cached?: { identity: string; sha: string; sections: ElfSection[] };
  clear(): void { this.cached = undefined; }
  async read(file: string, sha: string, section: MemorySection, symbol: MemorySymbol, offset: number): Promise<HexPage> {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= symbol.size || offset % PAGE_BYTES !== 0) throw new Error('Invalid HEX page offset.');
    if (!section.alloc || symbol.address < section.vma || symbol.address + symbol.size > section.vma + section.size) throw new Error('Symbol is outside the verified ELF section.');
    const handle = await fs.open(file, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 1073741824) throw new Error('Invalid ELF size.');
      const key = (s: typeof before) => [file, s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
      const identity = key(before);
      const read = async (position: number, size: number): Promise<Buffer> => {
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(size) || position < 0 || size < 0 || position + size > before.size || size > 4194304) throw new Error('ELF section data is out of bounds.');
        const data = Buffer.alloc(size); let done = 0;
        while (done < size) { const part = await handle.read(data, done, size - done, position + done); if (!part.bytesRead) throw new Error('ELF section data is truncated.'); done += part.bytesRead; }
        return data;
      };
      let sections = this.cached?.identity === identity && this.cached.sha === sha ? this.cached.sections : undefined;
      if (!sections) {
        const hash = createHash('sha256');
        for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) hash.update(chunk);
        if (hash.digest('hex') !== sha) throw new Error('ELF changed since analysis. Rebuild or refresh the report.');
        const header = await read(0, 52);
        if (header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 1 || header[5] !== 1 || header.readUInt16LE(18) !== 40 || ![2,3].includes(header.readUInt16LE(16))) throw new Error('HEX view requires a 32-bit little-endian ARM executable ELF.');
        const tableOffset = header.readUInt32LE(32), entrySize = header.readUInt16LE(46);
        if (!tableOffset || entrySize < 40) throw new Error('ELF section headers are unavailable.');
        const first = await read(tableOffset, entrySize);
        const count = header.readUInt16LE(48) || first.readUInt32LE(20);
        const stringIndex = header.readUInt16LE(50) === 0xffff ? first.readUInt32LE(24) : header.readUInt16LE(50);
        if (!count || stringIndex >= count) throw new Error('Invalid ELF section table.');
        const table = await read(tableOffset, count * entrySize);
        const stringHeader = table.subarray(stringIndex * entrySize, (stringIndex + 1) * entrySize);
        const strings = await read(stringHeader.readUInt32LE(16), stringHeader.readUInt32LE(20));
        sections = [];
        for (let i = 0; i < count; i++) {
          const h = table.subarray(i * entrySize, (i + 1) * entrySize), nameIndex = h.readUInt32LE(0);
          const end = strings.indexOf(0, nameIndex);
          if (nameIndex >= strings.length || end < nameIndex) throw new Error('Invalid ELF section name.');
          sections.push({ name: strings.toString('utf8', nameIndex, end), type: h.readUInt32LE(4), flags: h.readUInt32LE(8), address: h.readUInt32LE(12), offset: h.readUInt32LE(16), size: h.readUInt32LE(20) });
        }
      }
      const matches = sections.filter(s => s.name === section.name && s.address === section.vma && s.size === section.size && (s.flags & 2));
      if (matches.length !== 1) throw new Error('ELF section does not match the active report.');
      const actual = matches[0];
      if (actual.flags & 0x800) throw new Error('Compressed ELF sections are not supported in HEX view.');
      const storage = actual.type === 8 || !section.load ? 'nobits' : 'elf';
      const start = symbol.address - section.vma + offset;
      const bytes = storage === 'elf' ? [...await read(actual.offset + start, Math.min(PAGE_BYTES, symbol.size - offset))] : [];
      if (key(await handle.stat()) !== identity || key(await fs.stat(file)) !== identity) { this.clear(); throw new Error('ELF changed while reading bytes. Refresh the report.'); }
      this.cached = { identity, sha, sections };
      return { symbolId: symbol.id, name: symbol.name, section: section.name, address: symbol.address, loadAddress: section.load ? section.lma + symbol.address - section.vma : undefined, total: symbol.size, offset, bytes, storage };
    } finally { await handle.close(); }
  }
}

