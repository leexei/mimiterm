// 自動で付けるタブ名（セッション取り込み・MCPからの作成/リネーム）を整える。
// サイドバーは幅が限られるので、settings.autoNameStripPrefixes に挙げたプレフィックス
// （例: "PROJ-"）が番号の直前にあれば落として番号だけ残す。
// 手入力のリネームには適用しない（ユーザーが明示的に付けた名前は尊重する）
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function autoTabName(name, settings) {
  let out = String(name ?? '');
  const prefixes = Array.isArray(settings?.autoNameStripPrefixes) ? settings.autoNameStripPrefixes : [];
  for (const p of prefixes) {
    if (typeof p !== 'string' || !p) continue;
    // 語の途中から外すと番号が前の文字にくっつくので、その場合は空白で区切る
    out = out.replace(new RegExp(`${escapeRegExp(p)}(?=\\d)`, 'gi'), (_m, offset, str) =>
      offset > 0 && !/\s/.test(str[offset - 1]) ? ' ' : '',
    );
  }
  return out.trim();
}

module.exports = { autoTabName };
