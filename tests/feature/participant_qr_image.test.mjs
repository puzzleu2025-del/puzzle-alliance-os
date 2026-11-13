import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { participantQrModules } from '../../app/participant-qr-image.ts';
import decode from '../fixtures/jsqr.cjs';
import { build } from 'vite';

test('valid tokens produce the independently decoded QR matrices', () => {
  // The three reference matrices were decoded with jsQR 1.4.0 and a four-module quiet zone.
  for (const [token, expected] of [
    ['0123456789abcdef'.repeat(4), '822df17663339466711c292ead627d0495e59c8a72d0bf05789312aeaffc8c00'],
    ['f'.repeat(64), '80d4dc24d75c4ab7c5e425bc30c0c86e88565aa589bf4b139abdc49ea11afaf7'],
    ['0'.repeat(64), 'b177c8fd739b4e2abc9942ea95879b64cb0f9d118d0f346627b14e646352a747'],
  ]) {
    const modules = participantQrModules(token);
    assert.equal(modules.length, 33);
    assert.ok(modules.every(row => row.length === modules.length && row.every(value => typeof value === 'boolean')));
    assert.equal(createHash('sha256').update(JSON.stringify(modules)).digest('hex'), expected);
    const scale = 6, quiet = 4, width = (modules.length + quiet * 2) * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    for (let y = 0; y < modules.length; y++) for (let x = 0; x < modules.length; x++) if (modules[y][x]) {
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
        const i = (((y + quiet) * scale + dy) * width + (x + quiet) * scale + dx) * 4;
        pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
      }
    }
    assert.equal(decode(pixels, width, width)?.data, token);
  }
});

test('only a complete lowercase QR token is accepted', () => {
  for (const value of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64), 'a'.repeat(64)+'\n', 'https://example.com']) {
    assert.throws(() => participantQrModules(value), /INVALID_QR_TOKEN/);
  }
});

test('the client bundle contains the encoder and runs without a runtime require', async () => {
  const result = await build({ configFile: false, logLevel: 'error', build: { write: false, lib: { entry: 'app/participant-qr-image.ts', formats: ['es'] } } });
  const chunk = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk');
  assert.ok(chunk);
  const client = await import('data:text/javascript;base64,' + Buffer.from(chunk.code).toString('base64'));
  assert.deepEqual(client.participantQrModules('a'.repeat(64)), participantQrModules('a'.repeat(64)));
});
