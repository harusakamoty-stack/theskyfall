import { createHmac, createHash } from 'node:crypto';

// レコードID = email|pref|city のハッシュ（同じ組み合わせなら常に同じIDになる＝再登録しても重複しない）
export function makeRegistrationId(email, pref, city){
  return createHash('sha256').update(`${email.trim().toLowerCase()}|${pref}|${city}`).digest('hex').slice(0, 24);
}

// confirm / unsubscribe 用のトークンをその都度サーバー側の秘密鍵から再計算する。
// トークン自体をNetlify Blobsに保存する必要がないため、保存する個人情報を最小限にできる。
function secret(){
  const s = process.env.REGISTRATION_SECRET;
  if(!s) throw new Error('REGISTRATION_SECRET is not set');
  return s;
}

export function makeToken(purpose, id){
  return createHmac('sha256', secret()).update(`${purpose}:${id}`).digest('hex').slice(0, 32);
}

export function verifyToken(purpose, id, token){
  if(!token) return false;
  const expected = makeToken(purpose, id);
  if(expected.length !== token.length) return false;
  // タイミング攻撃対策の簡易的な定数時間比較
  let diff = 0;
  for(let i=0;i<expected.length;i++){ diff |= expected.charCodeAt(i) ^ token.charCodeAt(i); }
  return diff === 0;
}
