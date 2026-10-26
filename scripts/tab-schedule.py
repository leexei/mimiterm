#!/usr/bin/env python3
"""MimiTerm タブの予定日設定＋日付グループ移動を決定的に行うCLI。

Stop hook（auto_schedule.py）の正規表現検出に頼らず、明示的に呼んで確実に動かす版。
スキル /tab-move からも、手動からも使える。

使い方:
    tab-schedule.py <日付> [タブ参照]
    tab-schedule.py clear  [タブ参照]

日付の形式:
    2026-10-05 / 10/5 / 10月5日   … 年省略時は「今日以降になる直近の年」を補う
    +3                            … 3日後
    clear                         … 予定日を解除して「作業場」グループへ戻す

タブ参照を省略すると、実行中の tmux セッション（mimi-*）を対象にする。
終了コード: 0=成功（移動先グループ・予定日を検証済み） 1=失敗（理由をstderrへ）
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import date, timedelta

HOME_GROUP = '作業場'
CFG_PATH = os.path.expanduser('~/.mimiterm/mcp.json')


def die(msg):
    print(f'NG: {msg}', file=sys.stderr)
    sys.exit(1)


def parse_date(arg):
    today = date.today()
    if arg == 'clear':
        return None
    m = re.fullmatch(r'\+(\d{1,3})', arg)
    if m:
        return today + timedelta(days=int(m[1]))
    m = re.fullmatch(r'(\d{4})-(\d{1,2})-(\d{1,2})', arg)
    if m:
        try:
            return date(int(m[1]), int(m[2]), int(m[3]))
        except ValueError:
            die(f'不正な日付: {arg}')
    m = re.fullmatch(r'(\d{1,2})[/月](\d{1,2})日?', arg)
    if m:
        mo, dy = int(m[1]), int(m[2])
        for year in (today.year, today.year + 1):
            try:
                d = date(year, mo, dy)
            except ValueError:
                die(f'不正な日付: {arg}')
            if d >= today:
                return d
        die(f'不正な日付: {arg}')
    die(f'日付を解釈できない: {arg}（YYYY-MM-DD / M/D / +N / clear）')


def resolve_tab(argv_tab):
    if argv_tab:
        return argv_tab
    try:
        sess = subprocess.run(['tmux', 'display-message', '-p', '#S'],
                              capture_output=True, text=True, timeout=5).stdout.strip()
    except Exception:
        sess = ''
    if not sess.startswith('mimi-'):
        die('タブ参照が未指定で、tmuxセッションも特定できない')
    return sess


def mcp_call(cfg, name, args):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': name, 'arguments': args}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{cfg['port']}/mcp", data=body, headers={
        'Content-Type': 'application/json',
        'Authorization': f"Bearer {cfg['token']}",
    })
    with urllib.request.urlopen(req, timeout=5) as r:
        res = json.load(r)
    if 'error' in res:
        die(f"{name} が失敗: {res['error']}")
    return json.loads(res['result']['content'][0]['text'])


def find_tab(cfg, ref):
    data = mcp_call(cfg, 'list_tabs', {})
    for t in data.get('tabs', []):
        if ref in (t.get('tmuxSession'), t.get('id'), t.get('name')):
            return t
    return None


def main():
    if len(sys.argv) < 2:
        die(__doc__.strip())
    target = parse_date(sys.argv[1])
    tab_ref = resolve_tab(sys.argv[2] if len(sys.argv) > 2 else None)

    if not os.path.exists(CFG_PATH):
        die(f'{CFG_PATH} が無い（MimiTerm 未起動？）')
    cfg = json.load(open(CFG_PATH))

    if target is None:
        mcp_call(cfg, 'schedule_tab', {'tab': tab_ref, 'date': ''})
        mcp_call(cfg, 'move_tab_to_group', {'tab': tab_ref, 'group': HOME_GROUP})
        want_group, want_sched = HOME_GROUP, None
    else:
        iso = target.isoformat()
        mcp_call(cfg, 'schedule_tab', {'tab': tab_ref, 'date': iso})
        mcp_call(cfg, 'move_tab_to_group', {'tab': tab_ref, 'group': f'📅 {iso}'})
        want_group, want_sched = f'📅 {iso}', iso

    # 検証（ここまで到達しても実際に動いていなければ失敗扱いにする）
    tab = find_tab(cfg, tab_ref)
    if tab is None:
        die(f'タブが見つからない: {tab_ref}')
    if tab.get('group') != want_group or tab.get('scheduledFor') != want_sched:
        die(f"検証不一致: group={tab.get('group')} scheduledFor={tab.get('scheduledFor')}"
            f"（期待: {want_group} / {want_sched}）")
    print(f"OK: 「{tab.get('name')}」→ {want_group}（予定日: {want_sched or '解除'}）")


if __name__ == '__main__':
    main()
