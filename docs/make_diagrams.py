"""Draws the README diagrams as SVG cards (light card on any page theme), Korean and English."""
import os
import sys

out = sys.argv[1]
os.makedirs(out, exist_ok=True)

FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', 'Malgun Gothic', Helvetica, Arial, sans-serif"
INK = '#1f2328'
MUTED = '#59636e'
LINE = '#8c959f'
CARD = '#ffffff'
EDGE = '#d0d7de'
# node styles: fill, stroke, accent text
CLAUDE = ('#fbf1ea', '#d97757', '#b4532a')
PLUGIN = ('#eef1ff', '#6b7cff', '#3f4fd6')
GO = ('#e9f7ef', '#2da160', '#1a7f45')
YOU = ('#f6f8fa', '#8c959f', '#424a53')


def head(w, h):
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" font-family="{FONT}">\n'
        '<defs>\n'
        f'  <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{LINE}"/></marker>\n'
        '  <filter id="sh" x="-10%" y="-10%" width="120%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.2" flood-color="#1f2328" flood-opacity="0.10"/></filter>\n'
        '</defs>\n'
        f'<rect x="0.5" y="0.5" width="{w - 1}" height="{h - 1}" rx="14" fill="{CARD}" stroke="{EDGE}"/>\n'
    )


def node(x, y, w, h, style, title, sub=None, rx=10):
    fill, stroke, accent = style
    s = f'<g filter="url(#sh)"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/></g>\n'
    cy = y + h / 2
    if sub:
        s += f'<text x="{x + w / 2}" y="{cy - 4}" text-anchor="middle" font-size="15" font-weight="600" fill="{accent}">{title}</text>\n'
        s += f'<text x="{x + w / 2}" y="{cy + 15}" text-anchor="middle" font-size="12.5" fill="{MUTED}">{sub}</text>\n'
    else:
        s += f'<text x="{x + w / 2}" y="{cy + 5}" text-anchor="middle" font-size="15" font-weight="600" fill="{accent}">{title}</text>\n'
    return s


def arrow(x1, y1, x2, y2, label=None, lx=None, ly=None, both=False, dashed=False):
    dash = ' stroke-dasharray="5 4"' if dashed else ''
    start = ' marker-start="url(#arr)"' if both else ''
    s = f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{LINE}" stroke-width="1.6"{dash} marker-end="url(#arr)"{start}/>\n'
    if label:
        s += f'<text x="{lx}" y="{ly}" text-anchor="middle" font-size="12" fill="{MUTED}">{label}</text>\n'
    return s


def path(d, label=None, lx=None, ly=None):
    s = f'<path d="{d}" fill="none" stroke="{LINE}" stroke-width="1.6" marker-end="url(#arr)"/>\n'
    if label:
        s += f'<text x="{lx}" y="{ly}" text-anchor="middle" font-size="12" fill="{MUTED}">{label}</text>\n'
    return s


def flow(t):
    w, h = 820, 230
    s = head(w, h)
    s += node(28, 70, 92, 60, YOU, t['you'])
    s += node(176, 60, 170, 80, CLAUDE, 'Claude', t['claude_sub'])
    s += node(404, 60, 200, 80, PLUGIN, t['plugin'], 'go_chat · go_explore · go_agent')
    s += node(662, 60, 130, 80, GO, 'OpenCode Go', t['go_sub'])
    s += arrow(120, 100, 174, 100)
    s += arrow(346, 88, 402, 88, t['delegate'], 374, 78)
    s += arrow(604, 100, 660, 100, None, both=True)
    s += path('M 504 140 C 504 190, 261 190, 261 142', t['back'], 382, 205)
    s += '</svg>\n'
    return s


def lane(x, y, w, h, style, title):
    fill, stroke, accent = style
    s = f'<g filter="url(#sh)"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="12" fill="{fill}" stroke="{stroke}" stroke-width="1.5"/></g>\n'
    s += f'<text x="{x + w / 2}" y="{y + 28}" text-anchor="middle" font-size="15" font-weight="600" fill="{accent}">{title}</text>\n'
    return s


def step(x, y, w, h, label, style=('#ffffff', EDGE, INK)):
    fill, stroke, ink = style
    return (f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="1.3"/>\n'
            f'<text x="{x + w / 2}" y="{y + h / 2 + 5}" text-anchor="middle" font-size="14" fill="{ink}">{label}</text>\n')


def text(x, y, s, size=12, anchor='middle', color=MUTED):
    return f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-size="{size}" fill="{color}">{s}</text>\n'


def loop(t):
    w, h = 840, 380
    s = head(w, h)
    s += lane(24, 24, 160, 316, CLAUDE, 'Claude')
    s += lane(656, 24, 160, 316, GO, 'OpenCode Go')
    s += f'<rect x="210" y="24" width="420" height="316" rx="12" fill="#f7f8ff" stroke="{PLUGIN[1]}" stroke-width="1.5" stroke-dasharray="6 5"/>\n'
    s += text(420, 52, t['plugin'], 15, color=PLUGIN[2]).replace('font-size="15"', 'font-size="15" font-weight="600"')
    sx, sw = 262, 316
    cx = sx + sw / 2
    # the call in
    s += text(104, 104, 'go_agent(', 12.5) + text(104, 121, f"{t['task']}, check)", 12.5)
    s += arrow(184, 96, sx - 2, 96)
    # the loop
    s += step(sx, 78, sw, 36, t['s1'])
    s += step(sx, 140, sw, 36, t['s2'])
    s += step(sx, 202, sw, 36, t['s3'])
    s += arrow(cx, 114, cx, 138) + arrow(cx, 176, cx, 200)
    s += path(f'M {sx} 226 C {sx - 30} 226, {sx - 30} 108, {sx - 2} 108')
    s += text(cx + 10, 262, t['until'], 12, anchor='start')
    # Go
    s += arrow(sx + sw, 92, 654, 92) + text((sx + sw + 656) / 2, 84, t['ask'], 11)
    s += arrow(654, 158, sx + sw + 2, 158) + text((sx + sw + 656) / 2, 175, t['asks'], 11)
    s += text(736, 180, t['go_note1']) + text(736, 197, t['go_note2'])
    # the last check, the report
    s += step(sx, 278, sw, 36, t['s4'], ('#fff8e6', '#d4a72c', '#7d4e00'))
    s += arrow(cx, 238, cx, 276)
    s += arrow(sx, 296, 186, 296)
    s += text(104, 282, t['report1'], 12.5) + text(104, 299, t['report2'], 12)
    s += text(420, 364, t['note'], 12)
    s += '</svg>\n'
    return s


KO = {
    'you': '나', 'claude_sub': '지시 · 검토', 'plugin': '플러그인', 'go_sub': '월정액 모델',
    'delegate': '맡기기', 'back': '파일 · 짧은 보고서',
    'task': '작업', 's1': '① 지금까지의 대화를 Go에 보냄', 's2': '② Go가 요청: 읽기 · 고치기 · 명령',
    's3': '③ 권한 확인 후 실행, 결과를 붙임', 's4': '④ 확인 명령을 한 번 더 실행',
    'until': '①~③ 반복: 통과하거나 포기할 때까지', 'ask': '요청', 'asks': '도구 호출',
    'report1': '보고서', 'report2': '바뀐 파일 · 통과/실패',
    'note': 'Claude가 적어 준 명령만 · Claude가 쓸 수 있는 파일만', 'go_note1': '반복하는 동안', 'go_note2': 'Claude 토큰 0',
}
EN = {
    'you': 'You', 'claude_sub': 'instructs · reviews', 'plugin': 'Plugin', 'go_sub': 'flat-rate models',
    'delegate': 'delegates', 'back': 'files · short report',
    'task': 'task', 's1': '① send the conversation so far to Go', 's2': '② Go asks: read · edit · run',
    's3': '③ check permissions, do it, add the result', 's4': '④ run the check command once more',
    'until': 'repeat ①–③ until it passes', 'ask': 'request', 'asks': 'tool calls',
    'report1': 'report', 'report2': 'files changed · pass/fail',
    'note': "only Claude's listed commands · only files Claude may write", 'go_note1': 'no Claude tokens', 'go_note2': 'while it loops',
}

for lang, t in [('ko', KO), ('en', EN)]:
    open(f'{out}/flow.{lang}.svg', 'w').write(flow(t))
    open(f'{out}/agent-loop.{lang}.svg', 'w').write(loop(t))
print('ok', sorted(os.listdir(out)))
