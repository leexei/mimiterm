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
# 応答末尾に近いほど「次の予定」の記述である可能性が高い
tail = msg[-1200:]

today = date.today()
WD = {'月': 0, '火': 1, '水': 2, '木': 3, '金': 4, '土': 5, '日': 6}

def next_weekday(target):
    """今日より後で最初に来るその曜日"""
    delta = (target - today.weekday()) % 7
    return today + timedelta(days=delta or 7)

def next_week_weekday(target):
    """翌週（次の月曜起点の週）のその曜日"""
    next_monday = today + timedelta(days=(7 - today.weekday()) or 7)
    return next_monday + timedelta(days=target)

def find_date():
    # 明示日付: 8/12, 8月12日, 2026-08-12
    m = re.search(r'(\d{4})-(\d{2})-(\d{2})', tail)
    if m:
        return date(int(m[1]), int(m[2]), int(m[3]))
    m = re.search(r'(?<!\d)(\d{1,2})[/月](\d{1,2})日?(?!\d)', tail)
    if m:
        mo, dy = int(m[1]), int(m[2])
        if 1 <= mo <= 12 and 1 <= dy <= 31:
            y = today.year + (1 if (mo, dy) < (today.month, today.day) else 0)
            try:
                return date(y, mo, dy)
            except ValueError:
                return None
    # 相対表現
    if re.search(r'明後日', tail):
        return today + timedelta(days=2)
    if re.search(r'明日', tail):
        return today + timedelta(days=1)
    m = re.search(r'(\d+)日後', tail)
    if m:
        return today + timedelta(days=int(m[1]))
    m = re.search(r'来週([月火水木金土日])曜', tail)
    if m:
        return next_week_weekday(WD[m[1]])
    if re.search(r'来週', tail):
        return next_week_weekday(0)  # 曜日指定なしの「来週」は翌週月曜
    m = re.search(r'(?:次|今度)?の?([月火水木金土日])曜(?:日)?(?:に|には|以降)', tail)
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

d = find_date()
if d and d > today:
    iso = d.isoformat()
    call('schedule_tab', {'tab': sess, 'date': iso})
    call('move_tab_to_group', {'tab': sess, 'group': f'📅 {iso}'})
else:
    # 日付が確定できない延期表現 → 人が判断できるよう印だけ付ける
    call('set_tab_badge', {'tab': sess, 'badge': '🤔'})
