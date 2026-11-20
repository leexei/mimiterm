"""MimiTerm attention hook — Claude Code が人の入力を待ち始めた/待ち終わったことをタブに印として付ける。

attention-hook.sh から呼ばれる（引数: tmuxセッション名, mcp.jsonのパス / stdin: フックのJSON）。
イベント → 動作:
  PermissionRequest                  → permission（3秒後もまだ待っていれば）
  PreToolUse(AskUserQuestion)        → question  （同上）
  Notification permission_prompt     → permission（PermissionRequest の取りこぼし保険）
  Notification elicitation_* / agent_needs_input → question
  Notification quota_auto_resume_stale           → limit
  StopFailure                        → limit
  UserPromptSubmit / PostToolUse / PostToolUseFailure / PermissionDenied / Stop / SessionEnd
  / Notification quota_auto_resume_fired         → 解除
MCP 呼び出しは状態が変わる時だけ（マーカーファイルで判定）。PostToolUse のたびに叩かない。
"""
import json, os, sys, time, urllib.request
from pathlib import Path

sess, cfg_path = sys.argv[1], sys.argv[2]
try:
    ev = json.load(sys.stdin)
except Exception:
    sys.exit(0)

MARK_DIR = Path.home() / '.mimiterm' / 'attention'
MARK = MARK_DIR / sess
DELAY_SEC = 3  # 自動承認・即答で消える待ちは印を付けない（通知の空振り防止）

name = ev.get('hook_event_name', '')
agent = ev.get('agent_id') or ''

# 観測ログ（実測用）。秘密が混ざらないよう、ツール入力・メッセージ本文は記録しない。
# ~/.mimiterm/attention/events.log が 1MB を超えたら記録をやめる。
try:
    MARK_DIR.mkdir(parents=True, exist_ok=True)
    log = MARK_DIR / 'events.log'
    if not log.exists() or log.stat().st_size < 1_000_000:
        with open(log, 'a') as f:
            f.write(json.dumps({
                'at': time.strftime('%F %T'), 'event': name, 'tmux': sess,
                'session_id': ev.get('session_id'), 'agent_id': agent or None,
                'tool_name': ev.get('tool_name'), 'notification_type': ev.get('notification_type'),
                'error': ev.get('error'), 'permission_mode': ev.get('permission_mode'),
            }, ensure_ascii=False) + '\n')
except Exception:
    pass


def call(tool, args):
    cfg = json.load(open(cfg_path))
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call',
                       'params': {'name': tool, 'arguments': args}}).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{cfg['port']}/mcp", data=body, headers={
        'Content-Type': 'application/json', 'Authorization': f"Bearer {cfg['token']}"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.load(r)


def read_mark():
    try:
        return json.loads(MARK.read_text())
    except Exception:
        return None


def write_mark(m):
    MARK_DIR.mkdir(parents=True, exist_ok=True)
    tmp = MARK_DIR / f'.{sess}.{os.getpid()}.tmp'  # 同時に走るフック同士で衝突しないよう pid 別
    tmp.write_text(json.dumps(m))
    tmp.replace(MARK)


def set_wait(kind, message, delay):
    token = f"{time.time_ns()}"
    write_mark({'token': token, 'kind': kind, 'agent': agent, 'sent': False})
    if delay:
        time.sleep(delay)
        m = read_mark()
        if not m or m.get('token') != token:
            return  # 待っている間に解除（承認・回答・自動承認）された
    call('set_tab_attention', {'tab': sess, 'kind': kind, 'message': message[:200]})
    m = read_mark()
    if m and m.get('token') == token:
        m['sent'] = True
        write_mark(m)


def clear(force=False):
    m = read_mark()
    if not m:
        return
    # サブエージェントのツール完了で、本体の許可待ちを消さない（逆も同様）
    if not force and m.get('agent', '') != agent:
        return
    try:
        MARK.unlink()
    except FileNotFoundError:
        pass
    if m.get('sent'):
        call('set_tab_attention', {'tab': sess, 'kind': ''})


def tool_summary(ev):
    tool = ev.get('tool_name', '')
    ti = ev.get('tool_input') or {}
    detail = ti.get('command') or ti.get('file_path') or ti.get('url') or ti.get('description') or ''
    return f"{tool}: {str(detail).splitlines()[0][:120]}" if detail else tool


try:
    if name == 'PermissionRequest':
        # AskUserQuestion は PermissionRequest と PreToolUse の両方が来る（実測）。質問として PreToolUse 側で扱う
        if ev.get('tool_name') != 'AskUserQuestion':
            set_wait('permission', tool_summary(ev), DELAY_SEC)
    elif name == 'PreToolUse' and ev.get('tool_name') == 'AskUserQuestion':
        qs = (ev.get('tool_input') or {}).get('questions') or [{}]
        set_wait('question', str(qs[0].get('question', '質問があります')), DELAY_SEC)
    elif name == 'Notification':
        nt = ev.get('notification_type', '')
        msg = ev.get('message', '')
        if nt == 'permission_prompt':
            # 約6秒後の保険。すでに印（付与待ち含む）があれば重ねない（AskUserQuestion でも来る・実測）
            if not read_mark():
                set_wait('permission', msg, 0)
        elif nt in ('elicitation_dialog', 'elicitation_url_dialog', 'agent_needs_input'):
            set_wait('question', msg, 0)
        elif nt == 'quota_auto_resume_stale':
            set_wait('limit', msg or '上限リセット待ちのまま Enter 待ち', 0)
        elif nt == 'quota_auto_resume_fired':
            clear(force=True)
    elif name == 'StopFailure':
        err = ev.get('error', 'unknown')
        detail = ev.get('last_assistant_message') or ev.get('error_details') or ''
        set_wait('limit', f"{err}: {str(detail)[:150]}", 0)
    elif name == 'UserPromptSubmit':
        # 送信＝人が戻ってきた。MimiTerm 側が付けた ✍️（未送信）もここで外す
        clear(force=True)
        call('set_tab_attention', {'tab': sess, 'kind': ''})
    elif name in ('Stop', 'SessionEnd'):
        clear(force=True)
    elif name in ('PostToolUse', 'PostToolUseFailure', 'PermissionDenied'):
        clear()
except Exception as e:  # フックは絶対に Claude を止めない
    try:
        MARK_DIR.mkdir(parents=True, exist_ok=True)
        with open(MARK_DIR / 'errors.log', 'a') as f:
            f.write(f"{time.strftime('%F %T')} {sess} {name}: {e}\n")
    except Exception:
        pass
sys.exit(0)
