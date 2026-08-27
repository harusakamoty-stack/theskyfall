// ------------------------------------------------------------------
// @netlify/blobs の getStore() と同じ最小限のインターフェース（get / setJSON）を、
// ローカルファイルシステム（このリポジトリの data/cache/ 配下）で再現するモジュール。
//
// GitHub Actionsでの定期実行では、ジョブごとに毎回リポジトリをチェックアウトする
// だけで永続的なストレージ（Netlify Blobsのような）は使えない。そこで、キャッシュの
// 実体を data/cache/ 配下のJSONファイルとして書き出し、update-risk-data.yml が
// data/risk-data.json と一緒にリポジトリへコミットすることで、次回以降の実行でも
// 同じキャッシュを読み込めるようにしている。
//
// jma-area.mjs 側のキャッシュ利用ロジック（get→無ければ取得→setJSON）は
// 一切変更していない。インポート元をこのファイルに変えるだけで動くように、
// 同じ形（{ get(key, opts), setJSON(key, value) }）を持つオブジェクトを返す。
// ------------------------------------------------------------------

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// このファイルは netlify/functions/lib/ にあるので、3階層上がリポジトリルート。
const CACHE_ROOT = path.resolve(__dirname, '../../../data/cache');

function safeSegment(s){
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function fileFor(storeName, key){
  return path.join(CACHE_ROOT, `${safeSegment(storeName)}__${safeSegment(key)}.json`);
}

export function getStore(storeName){
  return {
    async get(key, _opts){
      try{
        const raw = await readFile(fileFor(storeName, key), 'utf8');
        return JSON.parse(raw);
      }catch(e){
        return null; // 未キャッシュ・ファイル無し・破損時は「無い」扱い（呼び出し側は再取得する）
      }
    },
    async setJSON(key, value){
      const file = fileFor(storeName, key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, JSON.stringify(value), 'utf8');
    },
  };
}
