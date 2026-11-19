import { test } from 'node:test';
import assert from 'node:assert';
import { suggestEmailCorrection } from './emailTypo.ts';

test('suggests the common provider for typical typos', () => {
  assert.strictEqual(suggestEmailCorrection('farmer@gmial.com'), 'farmer@gmail.com');
  assert.strictEqual(suggestEmailCorrection('farmer@gmail.con'), 'farmer@gmail.com');
  assert.strictEqual(suggestEmailCorrection('farmer@gamil.com'), 'farmer@gmail.com');
  assert.strictEqual(suggestEmailCorrection('farmer@gmail.cm'), 'farmer@gmail.com');
  assert.strictEqual(suggestEmailCorrection('Farmer@Hotmial.com'), 'farmer@hotmail.com');
  assert.strictEqual(suggestEmailCorrection('farmer@yahoo.co.tj'), 'farmer@yahoo.co.th');
  assert.strictEqual(suggestEmailCorrection('farmer@outlok.com'), 'farmer@outlook.com');
});

test('no suggestion for correct or genuinely different domains', () => {
  assert.strictEqual(suggestEmailCorrection('farmer@gmail.com'), null);
  assert.strictEqual(suggestEmailCorrection('farmer@hotmail.co.th'), null);
  assert.strictEqual(suggestEmailCorrection('phumiphat.suks@spumsail.net'), null);
  assert.strictEqual(suggestEmailCorrection('teacher@kmutt.ac.th'), null);
  assert.strictEqual(suggestEmailCorrection('a@me.com'), null);
  assert.strictEqual(suggestEmailCorrection('not-an-email'), null);
  assert.strictEqual(suggestEmailCorrection('x@'), null);
});
