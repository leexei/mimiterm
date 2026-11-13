// 再開予定日（tab.scheduledFor = 'YYYY-MM-DD'）から、タブ一覧の区切り（今日/明日/今週/それ以降/未定）を決める。
// サイドバー（レンダラーの <script>）と MCP サーバー（require）の両方から使うので、どちらでも読める形にしてある。
// 日付は保存せず毎回「今日」から計算するので、日付が変われば区切りは自動で移る。
(function (root) {
  // 並び順どおり。key は MCP の scheduleSection にもそのまま出す
  const SECTIONS = [
    { key: 'today', label: '今日' },
    { key: 'tomorrow', label: '明日' },
    { key: 'this-week', label: '今週' },
    { key: 'later', label: 'それ以降' },
    { key: 'unscheduled', label: '未定' },
  ];
  // 「今週」= 明後日から7日後まで。暦の週（日曜まで）にすると、金曜には来週月曜の予定が
  // 1か月先の予定と同じ「それ以降」に混ざり、日曜には常に空になるため、今日起点の7日間にしている
  const WEEK_DAYS = 7;

  const pad = (n) => String(n).padStart(2, '0');

  // ローカル時刻の YYYY-MM-DD（toISOString はUTCなので0〜9時にズレる）
  function todayStr(now = new Date()) {
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  }

  function addDays(ymd, days) {
    const [y, m, d] = ymd.split('-').map(Number);
    return todayStr(new Date(y, m - 1, d + days));
  }

  // 形式だけでなく暦として実在する日付か（2026-02-30 や 2026-13-45 を弾く）
  function isYmd(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && addDays(s, 0) === s;
  }

  // 再開予定日が来ている（今日 or 過ぎた）か。「今日」の区切りに入る条件と同じ
  function isDue(scheduledFor, today = todayStr()) {
    return isYmd(scheduledFor) && scheduledFor <= today;
  }

  // 予定日なし・形式が壊れた値は「未定」。過ぎた予定日は「今日」に入れて overdue を立てる
  function sectionOf(scheduledFor, today = todayStr()) {
    if (!isYmd(scheduledFor)) return { key: 'unscheduled', overdue: false };
    if (scheduledFor < today) return { key: 'today', overdue: true };
    if (scheduledFor === today) return { key: 'today', overdue: false };
    if (scheduledFor === addDays(today, 1)) return { key: 'tomorrow', overdue: false };
    if (scheduledFor <= addDays(today, WEEK_DAYS)) return { key: 'this-week', overdue: false };
    return { key: 'later', overdue: false };
  }

  // タブを区切りごとに分ける。該当0件の区切りは返さない。
  // 区切りの中は予定日の早い順（期限切れが「今日」の先頭に来る）、同じ日付どうしは元の並びを保つ
  function splitIntoSections(tabs, today = todayStr()) {
    const buckets = new Map(SECTIONS.map((s) => [s.key, []]));
    for (const tab of tabs) {
      const { key, overdue } = sectionOf(tab.scheduledFor, today);
      buckets.get(key).push({ tab, overdue });
    }
    const result = [];
    for (const { key, label } of SECTIONS) {
      const items = buckets.get(key);
      if (items.length === 0) continue;
      if (key !== 'unscheduled') {
        // Array.prototype.sort は安定ソート
        items.sort((a, b) => (a.tab.scheduledFor < b.tab.scheduledFor ? -1 : a.tab.scheduledFor > b.tab.scheduledFor ? 1 : 0));
      }
      result.push({
        key,
        label,
        tabs: items.map((i) => i.tab),
        overdueCount: items.filter((i) => i.overdue).length,
      });
    }
    return result;
  }

  // 見出しのツールチップ用: その区切りが指す日付の範囲
  function sectionRange(key, today = todayStr()) {
    if (key === 'today') return `${today} まで（過ぎた予定日を含む）`;
    if (key === 'tomorrow') return addDays(today, 1);
    if (key === 'this-week') return `${addDays(today, 2)} 〜 ${addDays(today, WEEK_DAYS)}`;
    if (key === 'later') return `${addDays(today, WEEK_DAYS + 1)} 以降`;
    return '再開予定日なし';
  }

  const api = { SECTIONS, todayStr, addDays, isYmd, isDue, sectionOf, splitIntoSections, sectionRange };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MimiSchedule = api;
})(typeof self !== 'undefined' ? self : this);
