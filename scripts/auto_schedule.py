#!/usr/bin/env python3
"""MimiTerm auto-schedule: Claudeの応答から予定日を検出しMCP経由でタブを整理する。
auto-schedule-hook.sh から呼ばれる（引数: tmuxセッション名, mcp.jsonのパス / stdin: Stop hookのJSON）"""
import json, re, sys, urllib.request
from datetime import date, timedelta

sess, cfg_path = sys.argv[1], sys.argv[2]
try:
    payload = json.load(sys.stdin)
except Exception:
    sys.exit(0)

msg = payload.get('last_assistant_message') or ''
if not msg:
    sys.exit(0)

# --- 判定範囲の絞り込み ---
# 本文中の日付は、例示・引用・箇条書き・コード・機能の説明であることが多く、
# 「このセッションを別日に再開する」宣言は応答の締めの文に現れる。
# そこで締めの数行だけを見る（誤検知したときの被害＝タブが勝手に動く、が大きいため保守的に）。
CODE_FENCE = re.compile(r'```.*?```', re.S)
INLINE_CODE = re.compile(r'`[^`]*`')
# 箇条書き・表・引用・見出しは説明や例の列挙であることが多い
LIST_LINE = re.compile(r'^\s*([-*+>#|]|\d+[.)]|[✅❌⚠️📋🔹•])')
# 例示であることを明示している行
EXAMPLE_MARK = re.compile(r'(例[:：]|例えば|たとえば|サンプル|のように書|みたいに言|と書くと|と言って締)')
# 自動整理機能そのものについて話している応答では動かさない（説明文の日付を拾わないため）
META_MARK = re.compile(r'(schedule_tab|auto[-_ ]?schedule|自動整理|Stop\s*hook|move_tab_to_group)')

if META_MARK.search(msg):
    sys.exit(0)

# 鉤括弧・引用符の中身は「こう書くと動く」という例示や発言の引用であることが多い。
# 本物の締めの宣言が丸ごと引用符に入ることはまずないので、中身ごと落とす
QUOTED = re.compile(r'[「『“”"][^「』」“”"]*[」』“”"]')

text = QUOTED.sub(' ', INLINE_CODE.sub(' ', CODE_FENCE.sub(' ', msg)))
lines = [l for l in text.split('\n') if l.strip()]
plain = [l for l in lines if not LIST_LINE.match(l) and not EXAMPLE_MARK.search(l)]
if not plain:
    sys.exit(0)
# 締めの最大3行（かつ400文字）だけを判定対象にする
scope_lines = plain[-3:]
tail = '\n'.join(scope_lines)[-400:]

today = date.today()
WD = {'月': 0, '火': 1, '水': 2, '木': 3, '金': 4, '土': 5, '日': 6}
# タブの再開予定として妥当な範囲。これを超える日付は本文中の別件の言及とみなす
MAX_HORIZON_DAYS = 120

def next_weekday(target):
    """今日より後で最初に来るその曜日"""
    delta = (target - today.weekday()) % 7
    return today + timedelta(days=delta or 7)

def next_week_weekday(target):
    """翌週（次の月曜起点の週）のその曜日"""
    next_monday = today + timedelta(days=(7 - today.weekday()) or 7)
    return next_monday + timedelta(days=target)

def resolve_month_day(mo, dy):
    """年のない「8/12」形式に年を補う。

    過去日になる場合、半年以上前なら翌年の予定（12月に「1/5」と書くケース）、
    直近の過去なら実績・経緯への言及（8/7に「8/6完了」と書くケース）とみなして採用しない。
    """
    if not (1 <= mo <= 12 and 1 <= dy <= 31):
        return None
    try:
        d = date(today.year, mo, dy)
    except ValueError:
        return None
    if d >= today:
        return d
    if (today - d).days > 180:
        try:
            return date(today.year + 1, mo, dy)
        except ValueError:
            return None
    return None


def find_date(scope):
    # 明示日付: 8/12, 8月12日, 2026-08-12
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})', scope)
    if m:
        try:
            d = date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            d = None
        # 遠すぎる日付はタブの再開予定ではない（過去日の引用や別件の年号）
        if d and today <= d <= today + timedelta(days=MAX_HORIZON_DAYS):
            return d
    m = re.search(r'(?<!\d)(\d{1,2})[/月](\d{1,2})日?(?!\d)', scope)
    if m:
        d = resolve_month_day(int(m[1]), int(m[2]))
        if d:
            return d
        # 直近の過去日（実績・経緯への言及）だった → 相対表現の判定に進む
    # 相対表現
    if re.search(r'明後日', scope):
        return today + timedelta(days=2)
    if re.search(r'明日', scope):
        return today + timedelta(days=1)
    m = re.search(r'(\d+)日後', scope)
    if m:
        return today + timedelta(days=int(m[1]))
    m = re.search(r'来週([月火水木金土日])曜', scope)
    if m:
        return next_week_weekday(WD[m[1]])
    if re.search(r'来週', scope):
        return next_week_weekday(0)  # 曜日指定なしの「来週」は翌週月曜
    m = re.search(r'(?:次|今度)?の?([月火水木金土日])曜(?:日)?(?:に|には|以降)', scope)
    if m:
        return next_weekday(WD[m[1]])
    return None

# 「別日にやる」意図があるか（この文脈がない日付は本文中の単なる言及なので拾わない）
DEFER = r'(あとで|後日|別日|次回|翌日|明日|明後日|来週|再開|持ち越|続きは|やる予定|着手|進める|対応(?:する|予定)|実施(?:する|予定)|待ち|保留|ペンディング|リマインド)'
if not re.search(DEFER, tail):
    sys.exit(0)

cfg = json.load(open(cfg_path))
BASE = f"http://127.0.0.1:{cfg['port']}/mcp"

def call(name, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
    req = urllib.request.Request(BASE, data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {cfg['token']}",
    })
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)

HOME_GROUP = '作業場'


def current_group_name():
    """このタブが今いるグループ名。取得できなければ None。"""
    try:
        res = call('list_tabs', {})
        data = json.loads(res['result']['content'][0]['text'])
    except Exception:
        return None
    for t in data.get('tabs', []):
        if sess in (t.get('tmuxSession'), t.get('id'), t.get('name')):
            return t.get('group')
    return None


# 延期の意図と日付が「同じ一文」に現れている場合のみ予定として採用する。
# （「8/12のリリースを調べた。あとで報告する」のような別々の文の組み合わせを拾わない）
d = None
for line in reversed(scope_lines):
    if re.search(DEFER, line):
        cand = find_date(line)
        if cand and today < cand <= today + timedelta(days=MAX_HORIZON_DAYS):
            d = cand
            break

if d:
    iso = d.isoformat()
    call('schedule_tab', {'tab': sess, 'date': iso})
    call('move_tab_to_group', {'tab': sess, 'group': f'📅 {iso}'})
elif re.search(r'(後日|別日|保留|ペンディング|持ち越|あとで|次回)', tail):
    # 日付が確定できない延期表現 → 人が判断できるよう印だけ付ける。
    # 日付グループに残っていると予定が確定しているように見えるので作業場へ戻す
    # （問い合わせ・レビュー待ちなど用途別グループはそのまま維持する）
    call('set_tab_badge', {'tab': sess, 'badge': '🤔'})
    group = current_group_name()
    if group and group.startswith('📅'):
        call('schedule_tab', {'tab': sess, 'date': ''})
        call('move_tab_to_group', {'tab': sess, 'group': HOME_GROUP})
