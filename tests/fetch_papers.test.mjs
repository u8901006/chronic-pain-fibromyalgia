import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/fetch_papers.mjs', import.meta.url));
const preload = `
import { writeFileSync } from 'node:fs';
const calls = [];
process.on('exit', () => writeFileSync('calls.json', JSON.stringify(calls)));
globalThis.fetch = async (url) => {
  const kind = url.includes('esearch.fcgi') ? 'search' : 'details';
  calls.push({kind, at: Date.now()});
  const mode = process.env.FETCH_TEST_MODE;
  if (mode === 'http_failure') return new Response('unavailable', {status: 503});
  if (kind === 'search') {
    return new Response(JSON.stringify({esearchresult: {idlist: mode === 'empty' ? [] : ['123', '456']}}));
  }
  if (mode === 'retry' && calls.filter(x => x.kind === 'details').length === 1) {
    return new Response('rate limited', {status: 429, headers: {'retry-after': '0'}});
  }
  if (mode === 'bad_xml') return new Response('<ERROR>Service unavailable</ERROR>');
  return new Response('<PubmedArticleSet><PubmedArticle status="test"><MedlineCitation>' +
    '<PMID Version="1">123</PMID><Article><ArticleTitle Language="eng">Fixture title</ArticleTitle>' +
    '<Journal><Title>Fixture Journal</Title></Journal><Abstract><AbstractText>Fixture abstract</AbstractText>' +
    '</Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>');
};
`;

for (const mode of ['retry', 'bad_xml', 'http_failure', 'empty']) {
  test(`PubMed CLI: ${mode}`, {timeout: 30000}, () => {
    const folder = mkdtempSync(join(tmpdir(), 'pubmed-test-'));
    try {
      mkdirSync(join(folder, 'docs'));
      const mock = join(folder, 'mock.mjs');
      writeFileSync(mock, preload);
      const result = spawnSync(process.execPath, ['--import', mock, script, '--output', 'papers.json'], {
        cwd: folder, encoding: 'utf8', timeout: 25000,
        env: {...process.env, FETCH_TEST_MODE: mode},
      });
      assert.ifError(result.error);
      const calls = JSON.parse(readFileSync(join(folder, 'calls.json'), 'utf8'));
      const output = join(folder, 'papers.json');
      if (mode === 'bad_xml' || mode === 'http_failure') {
        assert.notEqual(result.status, 0, result.stderr);
        assert.equal(existsSync(output), false, 'Failure must not publish an empty data file');
        assert.equal(existsSync(join(folder, 'docs/seen_pmids.json')), false);
        assert.match(result.stderr, mode === 'bad_xml' ? /no parseable articles/ : /PubMed HTTP 503/);
        if (mode === 'http_failure') assert.equal(calls.length, 3, 'HTTP retries must be bounded');
      } else {
        assert.equal(result.status, 0, result.stderr);
        const data = JSON.parse(readFileSync(output, 'utf8'));
        assert.equal(data.count, mode === 'empty' ? 0 : 1);
        if (mode === 'retry') {
          assert.equal(data.papers[0].pmid, '123');
          assert.equal(data.papers[0].title, 'Fixture title');
          assert.equal(data.papers[0].journal, 'Fixture Journal');
          assert.deepEqual(JSON.parse(readFileSync(join(folder, 'docs/seen_pmids.json'), 'utf8')), ['123']);
          assert.equal(calls.filter(x => x.kind === 'details').length, 2);
          for (let i = 1; i < calls.length; i++) {
            assert.ok(calls[i].at - calls[i - 1].at >= 300, 'NCBI requests must be throttled');
          }
        }
      }
    } finally {
      rmSync(folder, {recursive: true, force: true});
    }
  });
}
