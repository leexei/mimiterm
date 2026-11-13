#!/usr/bin/env python3
"""MimiTerm 司令塔タブ用スクリプト。

サブコマンド:
  hook   Claude Code の hook (Notification / Stop / PreToolUse) から呼ばれる。
         - タスクタブ: 「許可待ち・質問待ち・プラン承認待ち・ターン終了」を
           ~/.mimiterm/conductor/events.jsonl へ追記する
         - 司令塔タブ: 対象外タブ（非Claudeエージェントが動いたタブ）の中身を
           読もうとするツール呼び出しを拒否する
  wait   未読イベントが来るまで待ち、まとめて表示して終了する（司令塔がバックグラウンドで回す）
  skip   既読位置を末尾へ進める（司令塔の起動時に過去分を捨てる）

司令塔タブが登録されていない時・対象外タブ・司令塔自身・ユーザーが今見ているタブでは
イベントを書かない。追加のAI呼び出しはしない。
"""
import fcntl
import json
import os
import shutil
import subprocess
import sys
import time

HOME = os.path.expanduser('~')
STATE_DIR = os.path.join(HOME, '.mimiterm')
STATE_FILE = os.path.join(STATE_DIR, 'state.json')
SESSIONS_DIR = os.path.join(STATE_DIR, 'sessions')
AGENT_SESSIONS_DIR = os.path.join(STATE_DIR, 'agent-sessions')
CONDUCTOR_DIR = os.path.join(STATE_DIR, 'conductor')
EVENTS_FILE = os.path.join(CONDUCTOR_DIR, 'events.jsonl')
CURSOR_FILE = os.path.join(CONDUCTOR_DIR, 'cursor')
CONFIG_FILE = os.path.join(CONDUCTOR_DIR, 'config.json')
WATCHING_FILE = os.path.join(CONDUCTOR_DIR, 'watching')
LOCK_FILE = os.path.join(CONDUCTOR_DIR, 'events.lock')

MAX_MESSAGE = 700
MAX_EVENTS_BYTES = 512 * 1024
MIN_DENY_PATTERN = 4

KIND_LABELS = {
    'permission': '許可ダイアログ待ち',
    'dialog': '入力ダイアログ待ち',
    'question': '選択肢の質問待ち',
    'plan': 'プラン承認待ち',
    'needs_input': '入力待ち',
    'stopped': 'ターン終了',
}

NOTIFICATION_KINDS = {
    'permission_prompt': 'permission',
    'elicitation_dialog': 'dialog',
    'elicitation_url_dialog': 'dialog',
    'agent_needs_input': 'needs_input',
}


def load_json(path, retries=3):
    for i in range(retries):
        try:
            with open(path, encoding='utf-8') as f:
                return json.load(f)
        except FileNotFoundError:
            return None
        except (json.JSONDecodeError, OSError):
            time.sleep(0.05)
    return None


def tmux_session():
    if not os.environ.get('TMUX'):
        return None
    tmux = shutil.which('tmux') or '/opt/homebrew/bin/tmux'
    args = [tmux, 'display-message', '-p']
    pane = os.environ.get('TMUX_PANE')
    if pane:
        args += ['-t', pane]
    try:
        out = subprocess.run(args + ['#S'], capture_output=True, text=True, timeout=3).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return None
    return out if out.startswith('mimi-') else None


def is_excluded(tab):
    """非Claudeエージェントが動いたことのあるタブ、または手動で対象外にしたタブ。"""
    if tab.get('agentMarks') or tab.get('conductorExcluded'):
        return True
    # アプリが目印を付ける前（起動直後）でも、登録ファイルがあれば対象外として扱う
    return os.path.exists(os.path.join(AGENT_SESSIONS_DIR, f"{tab.get('tmuxSession')}.json"))


def find_conductor(state):
    cid = state.get('conductorTabId')
    if not cid:
        return None
    return next((t for t in state.get('tabs', []) if t.get('id') == cid), None)


def clip(text, limit=MAX_MESSAGE, tail=False):
    text = str(text or '').strip()
    if len(text) <= limit:
        return text
    return ('…' + text[-limit:]) if tail else (text[:limit] + '…')


# ---------- hook: イベント記録 ----------

def last_assistant_text(transcript_path):
    try:
        size = os.path.getsize(transcript_path)
        with open(transcript_path, 'rb') as f:
            f.seek(max(0, size - 1024 * 1024))
            lines = f.read().decode('utf-8', 'replace').split('\n')
    except OSError:
        return ''
    for line in reversed(lines):
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue
        if entry.get('type') != 'assistant':
            continue
        content = (entry.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        text = '\n'.join(c.get('text', '') for c in content if isinstance(c, dict) and c.get('type') == 'text').strip()
        if text:
            return text
    return ''


def describe_event(data):
    """hook入力から (kind, message) を返す。記録しないイベントは None。"""
    event = data.get('hook_event_name')
    if event == 'Notification':
        kind = NOTIFICATION_KINDS.get(data.get('notification_type'))
        return (kind, clip(data.get('message'))) if kind else None
    if event == 'PreToolUse':
        tool = data.get('tool_name')
        tin = data.get('tool_input') or {}
        if tool == 'AskUserQuestion':
            parts = []
            for q in tin.get('questions') or []:
                opts = ' / '.join(str(o.get('label', '')) for o in q.get('options') or [])
                parts.append(f"{q.get('question', '')} [{opts}]")
            return 'question', clip('\n'.join(parts))
        if tool == 'ExitPlanMode':
            return 'plan', clip(tin.get('plan'))
        return None
    if event == 'Stop':
        text = data.get('last_assistant_message') or last_assistant_text(data.get('transcript_path') or '')
        # 結論や質問は末尾に来るので、長い時は末尾側を残す
        return 'stopped', clip(text, tail=True)
    return None


class events_lock:
    """events.jsonl の追記・切り詰め・読み取りを排他する。"""

    def __enter__(self):
        os.makedirs(CONDUCTOR_DIR, exist_ok=True)
        self.f = open(LOCK_FILE, 'w')
        fcntl.flock(self.f, fcntl.LOCK_EX)

    def __exit__(self, *exc):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def append_event(record):
    line = json.dumps(record, ensure_ascii=False) + '\n'
    with events_lock():
        # 肥大化したら空にする（末尾を残すと、読み手が古い分を新着として読み直してしまう）。
        # 読み手は「既読位置 > サイズ」を見て先頭から読み直すので、新しいイベントは失われない
        mode = 'w' if events_size() > MAX_EVENTS_BYTES else 'a'
        with open(EVENTS_FILE, mode, encoding='utf-8') as f:
            f.write(line)


def watching_tab_id():
    """ユーザーが今まさに見ているタブ（ウィンドウが前面で、そのタブを表示中）。アプリが書く。"""
    try:
        with open(WATCHING_FILE) as f:
            return f.read().strip() or None
    except OSError:
        return None


# ---------- hook: 司令塔の読み取りガード ----------

GUARDED_TOOLS = {'Read', 'Bash', 'Grep', 'Glob', 'Monitor'}


def guard_needles(state):
    """司令塔に触らせない文字列: 対象外タブのtmuxセッション名・ClaudeセッションID、設定の denyPatterns。"""
    needles = {'agent-sessions', 'events.jsonl'}
    for tab in state.get('tabs', []):
        if not is_excluded(tab):
            continue
        sess = tab.get('tmuxSession')
        if sess:
            needles.add(sess)
            info = load_json(os.path.join(SESSIONS_DIR, f'{sess}.json'), retries=1) or {}
            if info.get('session_id'):
                needles.add(info['session_id'])
        if tab.get('claudeSessionId'):
            needles.add(tab['claudeSessionId'])
    config = load_json(CONFIG_FILE, retries=1) or {}
    for p in config.get('denyPatterns') or []:
        # 短すぎるパターンは無関係な呼び出しまで巻き込むので無視する
        if isinstance(p, str) and len(p) >= MIN_DENY_PATTERN:
            needles.add(p)
    return needles


def guard(data, state):
    if data.get('tool_name') not in GUARDED_TOOLS:
        return
    haystack = json.dumps(data.get('tool_input') or {}, ensure_ascii=False)
    hit = next((n for n in guard_needles(state) if n in haystack), None)
    if not hit:
        return
    print(json.dumps({
        'hookSpecificOutput': {
            'hookEventName': 'PreToolUse',
            'permissionDecision': 'deny',
            'permissionDecisionReason': (
                f'司令塔タブは対象外タブ（非Claudeエージェントが動いたタブ）の中身を読まない設定です: "{hit}" に一致。'
                '回避策を探さず、必要ならユーザーにそのタブを直接見てもらってください。'
            ),
        }
    }, ensure_ascii=False))


def cmd_hook():
    if not os.environ.get('TMUX'):
        return
    # 司令塔が未登録なら何もしない（全セッションのツール呼び出しで走るので、最短で抜ける）
    state = load_json(STATE_FILE)
    if not state:
        return
    conductor = find_conductor(state)
    if not conductor:
        return
    sess = tmux_session()
    if not sess:
        return
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError:
        return
    tab = next((t for t in state.get('tabs', []) if t.get('tmuxSession') == sess), None)
    if not tab:
        return
    if tab['id'] == conductor['id']:
        if data.get('hook_event_name') == 'PreToolUse':
            guard(data, state)
        return
    if is_excluded(tab):
        return
    # ユーザーが今そのタブを見ているなら、司令塔に知らせるまでもない
    if watching_tab_id() == tab['id']:
        return
    described = describe_event(data)
    if not described:
        return
    kind, message = described
    append_event({
        'ts': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'kind': kind,
        'tab': tab.get('name'),
        'tabId': tab['id'],
        'tmuxSession': sess,
        'message': message,
    })


# ---------- wait / skip: 司令塔側の受信 ----------

def read_cursor():
    try:
        with open(CURSOR_FILE) as f:
            return int(f.read().strip())
    except (OSError, ValueError):
        return None


def write_cursor(offset):
    os.makedirs(CONDUCTOR_DIR, exist_ok=True)
    tmp = CURSOR_FILE + '.tmp'
    with open(tmp, 'w') as f:
        f.write(str(offset))
    os.replace(tmp, CURSOR_FILE)


def events_size():
    try:
        return os.path.getsize(EVENTS_FILE)
    except OSError:
        return 0


def read_new(offset):
    """offset以降の完結した行を読み、(イベント一覧, 新しいoffset) を返す。"""
    with events_lock():
        size = events_size()
        if offset > size:  # 肥大化で空にされた
            offset = 0
        if size == offset:
            return [], offset
        with open(EVENTS_FILE, 'rb') as f:
            f.seek(offset)
            chunk = f.read()
    end = chunk.rfind(b'\n')
    if end < 0:
        return [], offset
    events = []
    for line in chunk[:end].decode('utf-8', 'replace').split('\n'):
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return events, offset + end + 1


def format_event(ev):
    label = KIND_LABELS.get(ev.get('kind'), ev.get('kind'))
    head = f"[{str(ev.get('ts', ''))[11:16]} {label}] {ev.get('tab')}  (tmux {ev.get('tmuxSession')} / mimiterm://tab/{ev.get('tabId')})"
    body = '\n'.join('    ' + l for l in str(ev.get('message') or '').split('\n') if l.strip())
    return head + ('\n' + body if body else '')


def cmd_skip():
    write_cursor(events_size())
    print('OK: 既読位置を末尾へ進めました')


def cmd_wait():
    offset = read_cursor()
    if offset is None:
        offset = events_size()
        write_cursor(offset)
    while True:
        events, new_offset = read_new(offset)
        if events:
            time.sleep(2)  # 続けて届くイベントを1回にまとめる
            events, new_offset = read_new(offset)
            write_cursor(new_offset)
            # 記録後に対象外になったタブ・閉じたタブのイベントは渡さない
            state = load_json(STATE_FILE) or {}
            allowed = {t.get('id') for t in state.get('tabs', []) if not is_excluded(t)}
            events = [ev for ev in events if ev.get('tabId') in allowed]
            if not events:
                offset = new_offset
                continue
            print(f'MimiTerm タスクタブからのイベント {len(events)}件:')
            for ev in events:
                print(format_event(ev))
            return
        offset = new_offset
        time.sleep(1)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ''
    if cmd == 'hook':
        try:
            cmd_hook()
        except Exception:  # hookの失敗でClaudeの動作を止めない
            pass
    elif cmd == 'wait':
        cmd_wait()
    elif cmd == 'skip':
        cmd_skip()
    else:
        print('Usage: conductor.py <hook|wait|skip>', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
