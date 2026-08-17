# -*- coding: utf-8 -*-
import os
import json

out_dir = 'design/mixdog-brand-pack'
icons_dir = os.path.join(out_dir, 'icons')
os.makedirs(icons_dir, exist_ok=True)

def tile(id_name, defs, body, rim_color='rgba(255,255,255,0.15)', bg_grad=(' #13141a', ' #0a0a0d', ' #020204')):
    g0 = bg_grad[0].strip()
    g1 = bg_grad[1].strip()
    g2 = bg_grad[2].strip()
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">\n'
        '  <defs>\n'
        '    <linearGradient id="' + id_name + '-bg" x1="0%" y1="0%" x2="100%" y2="100%">\n'
        '      <stop offset="0%" stop-color="' + g0 + '"/>\n'
        '      <stop offset="50%" stop-color="' + g1 + '"/>\n'
        '      <stop offset="100%" stop-color="' + g2 + '"/>\n'
        '    </linearGradient>\n'
        '    <linearGradient id="' + id_name + '-rim" x1="0%" y1="0%" x2="100%" y2="100%">\n'
        '      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.25"/>\n'
        '      <stop offset="50%" stop-color="#ffffff" stop-opacity="0.04"/>\n'
        '      <stop offset="100%" stop-color="' + rim_color + '" stop-opacity="0.28"/>\n'
        '    </linearGradient>\n'
        '    <filter id="' + id_name + '-sh" x="-10%" y="-10%" width="120%" height="120%">\n'
        '      <feDropShadow dx="0" dy="16" stdDeviation="22" flood-color="#000000" flood-opacity="0.88"/>\n'
        '    </filter>\n'
        '    ' + defs + '\n'
        '  </defs>\n'
        '  <rect x="32" y="32" width="448" height="448" rx="108" fill="url(#' + id_name + '-bg)" filter="url(#' + id_name + '-sh)"/>\n'
        '  <rect x="32.5" y="32.5" width="447" height="447" rx="107.5" fill="none" stroke="url(#' + id_name + '-rim)" stroke-width="1.5"/>\n'
        '  ' + body + '\n'
        '</svg>'
    )

icons = [
  # 1. Paseo & Monoline
  {
    'id': 'mx-01-paseo-monoline-m',
    'title': '01. Paseo Monoline M',
    'category': 'paseo',
    'catLabel': 'Paseo & Monoline',
    'tag': 'Single-Stroke G2 M',
    'desc': 'Paseo 스타일의 유려한 단일 획. 날렵한 하운드 귀와 중앙 터미널 꺾임각이 하나의 우아한 모노라인으로 연결됨',
    'accent': '#ffffff',
    'svg': tile('mx01',
      '<linearGradient id="mx01-line" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="60%" stop-color="#e2e8f0"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>',
      '<g stroke="url(#mx01-line)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round" fill="none"><path d="M 132 352 V 204 C 132 152 170 134 204 156 L 256 194 L 308 156 C 342 134 380 152 380 204 V 352"/><path d="M 198 280 L 256 338 L 314 280"/></g><circle cx="256" cy="242" r="7" fill="#38bdf8"/>'
    )
  },
  {
    'id': 'mx-02-paseo-cantilever-arch',
    'title': '02. Paseo Cantilever Arch',
    'category': 'paseo',
    'catLabel': 'Paseo & Monoline',
    'tag': 'Architectural Dual Arch',
    'desc': '스위스 모더니즘 캔틸레버 아치. 두 개의 독립된 곡선 기둥이 쫑긋한 귀를 형성하며 하단 프롬프트와 균형을 이룸',
    'accent': '#38bdf8',
    'svg': tile('mx02',
      '<linearGradient id="mx02-cyan" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 136 348 C 136 188 184 140 240 186" stroke="url(#mx02-cyan)" stroke-width="32"/><path d="M 376 348 C 376 188 328 140 272 186" stroke="#ffffff" stroke-width="32"/><path d="M 204 286 L 256 344 L 308 286" stroke="#ffffff" stroke-width="26"/><circle cx="256" cy="236" r="8" fill="#38bdf8"/></g>',
      '#38bdf8'
    )
  },
  {
    'id': 'mx-03-paseo-bracket-jowl',
    'title': '03. Paseo Bracket Jowl { }',
    'category': 'paseo',
    'catLabel': 'Paseo & Monoline',
    'tag': 'Code Brackets x Canine',
    'desc': '코드 블록을 감싸는 중괄호 { } 기호가 강아지의 볼선과 쫑긋한 귀로 자연스럽게 치환된 테크 미니멀 글리프',
    'accent': '#fbbf24',
    'svg': tile('mx03',
      '<linearGradient id="mx03-amber" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 176 144 C 136 184 136 220 164 256 C 136 292 136 328 176 368" stroke="url(#mx03-amber)" stroke-width="26"/><path d="M 336 144 C 376 184 376 220 348 256 C 376 292 376 328 336 368" stroke="url(#mx03-amber)" stroke-width="26"/><path d="M 228 220 L 264 256 L 228 292" stroke="#ffffff" stroke-width="22"/><line x1="220" y1="334" x2="292" y2="334" stroke="#ffffff" stroke-width="20"/><circle cx="256" cy="200" r="7" fill="#fbbf24"/></g>',
      '#fbbf24'
    )
  },
  {
    'id': 'mx-04-paseo-precision-hairline',
    'title': '04. Paseo Precision Hairline CAD',
    'category': 'paseo',
    'catLabel': 'Paseo & Monoline',
    'tag': 'Technical CAD Wireframe',
    'desc': '12px 정밀 테크니컬 헤어라인과 캘리브레이션 틱 마크. 하이엔드 엔지니어링 도구 감성',
    'accent': '#10b981',
    'svg': tile('mx04',
      '<linearGradient id="mx04-cad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#059669"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><circle cx="256" cy="256" r="140" stroke="rgba(255,255,255,0.12)" stroke-width="3" stroke-dasharray="8 8"/><path d="M 140 344 V 208 L 204 144 L 256 196 L 308 144 L 372 208 V 344" stroke="url(#mx04-cad)" stroke-width="16"/><path d="M 196 280 L 256 340 L 316 280" stroke="#ffffff" stroke-width="14"/><circle cx="204" cy="144" r="7" fill="#34d399"/><circle cx="308" cy="144" r="7" fill="#34d399"/><circle cx="256" cy="256" r="5" fill="#ffffff"/></g>',
      '#10b981'
    )
  },

  # 2. Orca Kinetic & Streamline
  {
    'id': 'mx-05-orca-streamline-cyan',
    'title': '05. Orca Streamline Cyan',
    'category': 'orca',
    'catLabel': 'Orca & Kinetic',
    'tag': 'Hydrodynamic Dual Fin',
    'desc': 'Orca 디자인의 핵심인 유선형 실루엣. 바다를 가르는 범고래 지느러미와 날렵한 도그 이어의 유기적 결합',
    'accent': '#38bdf8',
    'svg': tile('mx05',
      '<linearGradient id="mx05-flow" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="50%" stop-color="#6366f1"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>',
      '<g><path d="M 124 352 C 124 232 152 144 204 144 C 236 144 248 184 256 220 C 264 184 276 144 308 144 C 360 144 388 232 388 352 C 344 352 332 264 304 220 C 284 190 270 260 256 296 C 242 260 228 190 208 220 C 180 264 168 352 124 352 Z" fill="url(#mx05-flow)"/><path d="M 212 296 L 256 348 L 300 296" fill="none" stroke="#ffffff" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="270" r="7" fill="#ffffff"/></g>',
      '#38bdf8'
    )
  },
  {
    'id': 'mx-06-orca-kinetic-blade',
    'title': '06. Orca Kinetic Blade',
    'category': 'orca',
    'catLabel': 'Orca & Kinetic',
    'tag': 'Aerodynamic Twin Blade',
    'desc': '공기를 가르는 트윈 에어로포일 블레이드. M의 양쪽 날개가 전방으로 전진하는 속도감을 극대화',
    'accent': '#06b6d4',
    'svg': tile('mx06',
      '<linearGradient id="mx06-b1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#22d3ee"/><stop offset="100%" stop-color="#0284c7"/></linearGradient><linearGradient id="mx06-b2" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#4f46e5"/></linearGradient>',
      '<g><path d="M 130 348 C 130 200 176 140 226 176 C 210 230 190 280 160 348 Z" fill="url(#mx06-b1)"/><path d="M 382 348 C 382 200 336 140 286 176 C 302 230 322 280 352 348 Z" fill="url(#mx06-b2)"/><polygon points="226,176 256,140 286,176 256,236" fill="#ffffff"/><path d="M 204 290 L 256 348 L 308 290" fill="none" stroke="#ffffff" stroke-width="28" stroke-linecap="round" stroke-linejoin="round"/></g>',
      '#06b6d4'
    )
  },
  {
    'id': 'mx-07-orca-liquid-wave',
    'title': '07. Orca Minimal Wave',
    'category': 'orca',
    'catLabel': 'Orca & Kinetic',
    'tag': 'Pure Curvature Wave',
    'desc': '단 하나의 유기적 파동(Wave)으로 형성된 미니멀 하운드 마크. 단순함과 아이코닉함의 정점',
    'accent': '#f43f5e',
    'svg': tile('mx07',
      '<linearGradient id="mx07-wave" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb7185"/><stop offset="50%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 136 348 V 230 C 136 170 176 144 212 174 C 236 196 248 230 256 256 C 264 230 276 196 300 174 C 336 144 376 170 376 230 V 348" stroke="url(#mx07-wave)" stroke-width="36"/><circle cx="256" cy="326" r="14" fill="#ffffff"/></g>',
      '#f43f5e'
    )
  },
  {
    'id': 'mx-08-orca-super-stream',
    'title': '08. Orca Super Streamline',
    'category': 'orca',
    'catLabel': 'Orca & Kinetic',
    'tag': 'Continuous G2 Velocity',
    'desc': '곡률 연속성(G2 Continuity)이 완벽히 계산된 2개의 광속 스트림. 상단은 M 모노그램, 하단은 프롬프트 노즈',
    'accent': '#a855f7',
    'svg': tile('mx08',
      '<linearGradient id="mx08-stream" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 140 340 C 120 220 150 148 200 148 C 236 148 250 196 256 228 C 262 196 276 148 312 148 C 362 148 392 220 372 340" stroke="url(#mx08-stream)" stroke-width="34"/><path d="M 194 274 L 256 336 L 318 274" stroke="#ffffff" stroke-width="30"/><circle cx="256" cy="290" r="7" fill="#38bdf8"/></g>',
      '#a855f7'
    )
  },

  # 3. Linear & Cursor Facets
  {
    'id': 'mx-09-cursor-prism-facet',
    'title': '09. Cursor 3D Prism Facet',
    'category': 'linear',
    'catLabel': 'Linear & Cursor Facets',
    'tag': 'Isometric Beveled Hound',
    'desc': 'Cursor / Zed 스타일의 아이소메트릭 3D 각면 분할. 광원 방향에 따른 면 음영과 중앙 화이트 스펙큘러 노즈',
    'accent': '#38bdf8',
    'svg': tile('mx09',
      '<linearGradient id="mx09-top-l" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient><linearGradient id="mx09-top-r" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#7e22ce"/></linearGradient><linearGradient id="mx09-wall-l" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#1e293b"/><stop offset="100%" stop-color="#0f172a"/></linearGradient><linearGradient id="mx09-wall-r" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#2e1065"/><stop offset="100%" stop-color="#0f172a"/></linearGradient><linearGradient id="mx09-dart" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#94a3b8"/></linearGradient>',
      '<g><polygon points="128,348 128,208 178,148 178,288" fill="url(#mx09-wall-l)"/><polygon points="178,148 244,208 178,236" fill="url(#mx09-top-l)"/><polygon points="178,236 244,208 256,264 190,292" fill="#0369a1"/><polygon points="384,348 384,208 334,148 334,288" fill="url(#mx09-wall-r)"/><polygon points="334,148 268,208 334,236" fill="url(#mx09-top-r)"/><polygon points="334,236 268,208 256,264 322,292" fill="#4338ca"/><polygon points="190,292 256,264 322,292 256,364" fill="url(#mx09-dart)"/><line x1="256" y1="148" x2="256" y2="364" stroke="#ffffff" stroke-width="2" opacity="0.6"/></g>',
      '#38bdf8'
    )
  },
  {
    'id': 'mx-10-linear-confluence-ribbon',
    'title': '10. Linear Confluence Ribbon',
    'category': 'linear',
    'catLabel': 'Linear & Cursor Facets',
    'tag': 'Interlocking Infinity Ribbon',
    'desc': 'Linear 특유의 뫼비우스 리본 텍스처. 2개의 곡면 밴드가 유기적으로 교차하며 멀티 모델 융합을 상징',
    'accent': '#6366f1',
    'svg': tile('mx10',
      '<linearGradient id="mx10-ribbon" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="40%" stop-color="#6366f1"/><stop offset="80%" stop-color="#c084fc"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 144 344 C 118 256 126 156 182 144 C 230 132 248 196 256 226 C 264 196 282 132 330 144 C 386 156 394 256 368 344" stroke="url(#mx10-ribbon)" stroke-width="36"/><path d="M 194 276 L 256 338 L 318 276" stroke="#ffffff" stroke-width="28"/><circle cx="256" cy="290" r="7" fill="#38bdf8"/></g>',
      '#6366f1'
    )
  },
  {
    'id': 'mx-11-zed-origami-shard',
    'title': '11. Zed Origami Shard',
    'category': 'linear',
    'catLabel': 'Linear & Cursor Facets',
    'tag': 'High-Tech Origami Fold',
    'desc': '종이접기(Origami) 공학에서 영감을 얻은 예리한 면 분할. 고성능 Rust 기반 코드 에디터 감성',
    'accent': '#f59e0b',
    'svg': tile('mx11',
      '<linearGradient id="mx11-sh1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient><linearGradient id="mx11-sh2" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#78350f"/></linearGradient>',
      '<g><polygon points="136,344 176,144 240,214 176,274" fill="url(#mx11-sh1)"/><polygon points="376,344 336,144 272,214 336,274" fill="url(#mx11-sh2)"/><polygon points="240,214 256,168 272,214 256,260" fill="#ffffff"/><polygon points="204,274 256,344 308,274 256,310" fill="#ffffff"/><circle cx="256" cy="236" r="6" fill="#fbbf24"/></g>',
      '#f59e0b'
    )
  },
  {
    'id': 'mx-12-raycast-monolith-slab',
    'title': '12. Raycast Titanium Monolith',
    'category': 'linear',
    'catLabel': 'Linear & Cursor Facets',
    'tag': 'Machined 45° Chamfer Slabs',
    'desc': 'CNC 정밀 가공된 스페이스 그레이 티타늄 슬랩 2개와 중앙 45도 레이저 분할선',
    'accent': '#94a3b8',
    'svg': tile('mx12',
      '<linearGradient id="mx12-ti-l" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f8fafc"/><stop offset="50%" stop-color="#94a3b8"/><stop offset="100%" stop-color="#334155"/></linearGradient><linearGradient id="mx12-ti-r" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#e2e8f0"/><stop offset="50%" stop-color="#64748b"/><stop offset="100%" stop-color="#1e293b"/></linearGradient><linearGradient id="mx12-laser" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fffbeb"/><stop offset="100%" stop-color="#f59e0b"/></linearGradient>',
      '<g><path d="M 136 348 V 212 L 204 144 L 244 184 L 204 224 V 348 Z" fill="url(#mx12-ti-l)"/><path d="M 376 348 V 212 L 308 144 L 268 184 L 308 224 V 348 Z" fill="url(#mx12-ti-r)"/><path d="M 204 286 L 256 344 L 308 286" fill="none" stroke="url(#mx12-laser)" stroke-width="26" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="254" r="8" fill="#f59e0b"/></g>',
      '#f59e0b'
    )
  },

  # 4. Multi-Model Aperture
  {
    'id': 'mx-13-aperture-triad-core',
    'title': '13. Aperture Triad Nexus',
    'category': 'aperture',
    'catLabel': 'Multi-Model Aperture',
    'tag': '120° Rotational Camera Iris',
    'desc': '3대 메이저 모델(Claude + OpenAI + Gemini)을 상징하는 120도 회전 아크와 중앙 도그 노즈 렌즈 코어',
    'accent': '#00f2fe',
    'svg': tile('mx13',
      '<linearGradient id="mx13-a1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient><linearGradient id="mx13-a2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#6366f1"/></linearGradient><linearGradient id="mx13-a3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fb923c"/></linearGradient>',
      '<g fill="none" stroke-width="32" stroke-linecap="round"><path d="M 232 122 A 136 136 0 0 1 383 210" stroke="url(#mx13-a1)"/><path d="M 232 122 A 136 136 0 0 1 383 210" transform="rotate(120 256 256)" stroke="url(#mx13-a2)"/><path d="M 232 122 A 136 136 0 0 1 383 210" transform="rotate(240 256 256)" stroke="url(#mx13-a3)"/></g><g><circle cx="236" cy="232" r="7" fill="#ffffff"/><circle cx="276" cy="232" r="7" fill="#ffffff"/><path d="M 240 256 L 256 272 L 272 256" fill="none" stroke="#00f2fe" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="252" r="7" fill="#ffffff"/></g>',
      '#00f2fe'
    )
  },
  {
    'id': 'mx-14-borromean-hound-knot',
    'title': '14. Borromean Hound Knot',
    'category': 'aperture',
    'catLabel': 'Multi-Model Aperture',
    'tag': '3-Way Interlocked Trinity',
    'desc': '어느 하나도 분리되지 않는 보로메오의 매듭(Borromean Rings). 완벽한 모델 오케스트레이션과 합의 알고리즘',
    'accent': '#c084fc',
    'svg': tile('mx14',
      '<linearGradient id="mx14-c1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient><linearGradient id="mx14-c2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#7e22ce"/></linearGradient><linearGradient id="mx14-c3" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fb923c"/><stop offset="100%" stop-color="#ea580c"/></linearGradient>',
      '<g fill="none" stroke-width="26" stroke-linecap="round"><circle cx="216" cy="210" r="72" stroke="url(#mx14-c1)"/><circle cx="296" cy="210" r="72" stroke="url(#mx14-c2)"/><circle cx="256" cy="290" r="72" stroke="url(#mx14-c3)"/></g><path d="M 226 280 L 256 314 L 286 280" fill="none" stroke="#ffffff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="242" r="9" fill="#ffffff"/>',
      '#c084fc'
    )
  },
  {
    'id': 'mx-15-delta-nexus-router',
    'title': '15. Delta Nexus Routing Node',
    'category': 'aperture',
    'catLabel': 'Multi-Model Aperture',
    'tag': 'Git-Fork Merge & Dispatch',
    'desc': '3방향 Git 브랜치 포크 & 머지 트리 형상. 다중 에이전트 태스크 분배 및 통합 프로세스',
    'accent': '#34d399',
    'svg': tile('mx15',
      '<linearGradient id="mx15-emerald" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#059669"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="150" y1="344" x2="256" y2="236" stroke="url(#mx15-emerald)" stroke-width="28"/><line x1="362" y1="344" x2="256" y2="236" stroke="url(#mx15-emerald)" stroke-width="28"/><line x1="256" y1="144" x2="256" y2="236" stroke="#ffffff" stroke-width="28"/><path d="M 204 290 L 256 348 L 308 290" stroke="#ffffff" stroke-width="26"/><circle cx="150" cy="344" r="16" fill="#34d399"/><circle cx="362" cy="344" r="16" fill="#34d399"/><circle cx="256" cy="144" r="16" fill="#ffffff"/><circle cx="256" cy="236" r="18" fill="#0f172a" stroke="#34d399" stroke-width="6"/></g>',
      '#34d399'
    )
  },
  {
    'id': 'mx-16-anthropic-spark-matrix',
    'title': '16. Anthropic Spark Hound',
    'category': 'aperture',
    'catLabel': 'Multi-Model Aperture',
    'tag': '4-Point AI Intelligence Spark',
    'desc': 'Anthropic / Claude의 대표적인 4포인트 스파크가 믹스독 마크 중앙에 융합된 테라코타 & 샌드스톤 에디션',
    'accent': '#d97706',
    'svg': tile('mx16',
      '<linearGradient id="mx16-spark" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fde68a"/><stop offset="50%" stop-color="#f59e0b"/><stop offset="100%" stop-color="#b45309"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 140 348 V 210 C 140 156 178 136 210 158 L 256 196 L 302 158 C 334 136 372 156 372 210 V 348" stroke="#cbd5e1" stroke-width="28"/><path d="M 256 186 C 256 226 276 246 316 246 C 276 246 256 266 256 306 C 256 266 236 246 196 246 C 236 246 256 226 256 186 Z" fill="url(#mx16-spark)"/><path d="M 212 300 L 256 348 L 300 300" stroke="url(#mx16-spark)" stroke-width="24"/></g>',
      '#f59e0b',
      ('#181512', '#0f0c0a', '#050403')
    )
  },

  # 5. Terminal Primitives
  {
    'id': 'mx-17-ghostty-phosphor-terminal',
    'title': '17. Ghostty CRT Matrix Phosphor',
    'category': 'terminal',
    'catLabel': 'Terminal Primitives',
    'tag': 'CLI Prompt > & Blinking Cursor _',
    'desc': 'Ghostty 터미널의 네온 토식 라임 감성. 프롬프트 화살표와 블록 커서가 일체화된 도그 스나우트',
    'accent': '#22c55e',
    'svg': tile('mx17',
      '<linearGradient id="mx17-ghostty" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#4ade80"/><stop offset="100%" stop-color="#16a34a"/></linearGradient><filter id="mx17-glow"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
      '<g filter="url(#mx17-glow)"><path d="M 148 348 L 148 200 L 208 140" fill="none" stroke="url(#mx17-ghostty)" stroke-width="32" stroke-linecap="round"/><path d="M 364 348 L 364 200 L 304 140" fill="none" stroke="url(#mx17-ghostty)" stroke-width="32" stroke-linecap="round"/><path d="M 194 220 L 256 270 L 194 320" fill="none" stroke="#ffffff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round"/><rect x="276" y="304" width="48" height="18" rx="4" fill="url(#mx17-ghostty)"/><circle cx="256" cy="180" r="8" fill="#4ade80"/></g>',
      '#22c55e',
      ('#0b140d', '#050c07', '#010402')
    )
  },
  {
    'id': 'mx-18-code-slash-bone',
    'title': '18. Dual Slash // Code Bone',
    'category': 'terminal',
    'catLabel': 'Terminal Primitives',
    'tag': '45° Syntax Comment & Bone',
    'desc': '프로그래밍 주석 슬래시 // 2개가 정밀한 45도로 교차하며 세련된 본(Bone) 형상을 완성',
    'accent': '#38bdf8',
    'svg': tile('mx18',
      '<linearGradient id="mx18-slash1" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#6366f1"/></linearGradient><linearGradient id="mx18-slash2" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ec4899"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><line x1="170" y1="344" x2="270" y2="144" stroke="url(#mx18-slash1)" stroke-width="36"/><line x1="242" y1="344" x2="342" y2="144" stroke="url(#mx18-slash2)" stroke-width="36"/><circle cx="170" cy="344" r="18" fill="#38bdf8"/><circle cx="270" cy="144" r="18" fill="#6366f1"/><circle cx="242" cy="344" r="18" fill="#ec4899"/><circle cx="342" cy="144" r="18" fill="#f43f5e"/><circle cx="256" cy="244" r="10" fill="#ffffff"/></g>',
      '#ec4899'
    )
  },
  {
    'id': 'mx-19-silicon-chip-trace',
    'title': '19. Silicon IC Die Trace',
    'category': 'terminal',
    'catLabel': 'Terminal Primitives',
    'tag': 'PCB Gold Trace & Neural Core',
    'desc': '반도체 실리콘 다이 기판의 골드 트레이스 버스 라인. 하드웨어 레벨의 초저지연 로컬 에이전트 연상',
    'accent': '#fbbf24',
    'svg': tile('mx19',
      '<linearGradient id="mx19-gold" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fef08a"/><stop offset="50%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#b45309"/></linearGradient>',
      '<g stroke="url(#mx19-gold)" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 124 352 V 212 L 180 156 L 224 200 L 256 168" stroke-width="26"/><circle cx="124" cy="352" r="10" fill="#fbbf24" stroke="none"/><circle cx="180" cy="156" r="10" fill="#fbbf24" stroke="none"/><path d="M 388 352 V 212 L 332 156 L 288 200 L 256 168" stroke-width="26"/><circle cx="388" cy="352" r="10" fill="#fbbf24" stroke="none"/><circle cx="332" cy="156" r="10" fill="#fbbf24" stroke="none"/><rect x="236" y="148" width="40" height="40" rx="8" fill="#1e293b" stroke="#fbbf24" stroke-width="4"/><circle cx="256" cy="168" r="6" fill="#ffffff" stroke="none"/><path d="M 196 284 L 256 344 L 316 284" stroke="#ffffff" stroke-width="26"/><circle cx="256" cy="344" r="10" fill="#fbbf24" stroke="none"/></g>',
      '#fbbf24'
    )
  },
  {
    'id': 'mx-20-cli-shebang-warp',
    'title': '20. Unix Shebang #! Prompt',
    'category': 'terminal',
    'catLabel': 'Terminal Primitives',
    'tag': 'Unix Script Node',
    'desc': '스크립트 최상단 셰뱅(#! = Hashbang)과 터미널 꺾쇠 괄호가 조합된 유닉스 해커 감성의 로고',
    'accent': '#a855f7',
    'svg': tile('mx20',
      '<linearGradient id="mx20-shebang" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 140 348 V 204 L 204 140 L 256 192 L 308 140 L 372 204 V 348" stroke="url(#mx20-shebang)" stroke-width="30"/><line x1="236" y1="230" x2="236" y2="286" stroke="#ffffff" stroke-width="20"/><circle cx="236" cy="316" r="9" fill="#ffffff"/><path d="M 276 244 L 304 272 L 276 300" stroke="#38bdf8" stroke-width="18"/></g>',
      '#a855f7'
    )
  },

  # 6. Canine Cybernetics
  {
    'id': 'mx-21-cyber-hound-apex',
    'title': '21. Cyber Hound Apex Crest',
    'category': 'canine',
    'catLabel': 'Canine Cybernetics',
    'tag': 'Faceted AI Hound Mask',
    'desc': '날렵한 그레이하운드의 공기역학적 안면 골격. 앰버 & 사이언 듀얼 바이저와 레이저 시선',
    'accent': '#ff7a00',
    'svg': tile('mx21',
      '<linearGradient id="mx21-l" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ff7a00"/><stop offset="100%" stop-color="#ea580c"/></linearGradient><linearGradient id="mx21-r" x1="100%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient>',
      '<g transform="translate(0, 8)"><path d="M 124 336 L 158 136 C 160 124 175 118 184 127 L 236 182 L 196 336 Z" fill="url(#mx21-l)"/><path d="M 388 336 L 354 136 C 352 124 337 118 328 127 L 276 182 L 316 336 Z" fill="url(#mx21-r)"/><polygon points="236,182 256,156 276,182 256,224" fill="#ffffff"/><polygon points="214,242 298,242 256,338" fill="#f1f5f9"/><polygon points="242,308 270,308 256,326" fill="#0f172a"/><polygon points="186,214 220,230 200,236" fill="#38bdf8"/><polygon points="326,214 292,230 312,236" fill="#ff7a00"/><rect x="160" y="360" width="192" height="10" rx="5" fill="#ff7a00"/><circle cx="256" cy="365" r="7" fill="#ffffff"/></g>',
      '#ff7a00'
    )
  },
  {
    'id': 'mx-22-minimal-paw-4pill',
    'title': '22. Geometric Minimal Paw 4-Pad',
    'category': 'canine',
    'catLabel': 'Canine Cybernetics',
    'tag': '4-Pad Precision Geometry',
    'desc': '4개의 둥근 알약형 패드가 대칭 배열된 모던 댕댕이 풋프린트. 친근함과 테크의 조화',
    'accent': '#ec4899',
    'svg': tile('mx22',
      '<linearGradient id="mx22-paw" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="50%" stop-color="#c084fc"/><stop offset="100%" stop-color="#38bdf8"/></linearGradient>',
      '<g fill="url(#mx22-paw)"><ellipse cx="256" cy="300" rx="68" ry="48"/><rect x="144" y="196" width="36" height="64" rx="18" transform="rotate(-25 162 228)"/><rect x="206" y="160" width="36" height="70" rx="18" transform="rotate(-8 224 195)"/><rect x="270" y="160" width="36" height="70" rx="18" transform="rotate(8 288 195)"/><rect x="332" y="196" width="36" height="64" rx="18" transform="rotate(25 350 228)"/></g><circle cx="256" cy="292" r="12" fill="#ffffff"/>',
      '#ec4899'
    )
  },
  {
    'id': 'mx-23-howling-hound-triad',
    'title': '23. Howling Hound Triad',
    'category': 'canine',
    'catLabel': 'Canine Cybernetics',
    'tag': 'Upward Apex Vector',
    'desc': '하늘을 향해 포효하는 하운드의 역동적인 상승 각도. 대문자 M과 완벽하게 정합된 3개의 정점',
    'accent': '#38bdf8',
    'svg': tile('mx23',
      '<linearGradient id="mx23-apex" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#818cf8"/></linearGradient>',
      '<g><polygon points="128,348 196,140 256,260 216,348" fill="url(#mx23-apex)"/><polygon points="384,348 316,140 256,260 296,348" fill="#ffffff" fill-opacity="0.9"/><polygon points="216,280 256,190 296,280 256,348" fill="#00f2fe"/><circle cx="256" cy="270" r="8" fill="#ffffff"/></g>',
      '#38bdf8'
    )
  },
  {
    'id': 'mx-24-smart-collar-tag',
    'title': '24. Singularity Collar Bell Tag',
    'category': 'canine',
    'catLabel': 'Canine Cybernetics',
    'tag': 'Diamond Pendant Tag',
    'desc': '믹스독의 상징인 스마트 목줄 펜던트. 다이아몬드 싱귤래리티 코어가 중앙에 장착된 럭셔리 마크',
    'accent': '#f59e0b',
    'svg': tile('mx24',
      '<linearGradient id="mx24-gold" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 148 348 V 204 L 204 148 L 256 200 L 308 148 L 364 204 V 348" stroke="#ffffff" stroke-width="28"/><rect x="224" y="244" width="64" height="64" rx="16" transform="rotate(45 256 276)" fill="url(#mx24-gold)" stroke="#ffffff" stroke-width="4"/><circle cx="256" cy="276" r="10" fill="#ffffff"/></g>',
      '#f59e0b'
    )
  },

  # 7. Solid & Ultra-Minimal
  {
    'id': 'mx-25-solid-minimal-vercel',
    'title': '25. Solid Minimal Glyph',
    'category': 'solid',
    'catLabel': 'Solid & Ultra-Minimal',
    'tag': 'Pure Contrast Monolith',
    'desc': 'Vercel / Apple 스타일의 고대비 흑백 단색 솔리드. 16px 마이크로 파비콘부터 초대형 사이니지까지 무결점 시인성',
    'accent': '#ffffff',
    'svg': tile('mx25',
      '',
      '<g fill="#ffffff"><path d="M 136 348 V 200 C 136 156 168 136 204 156 L 256 190 L 308 156 C 344 136 376 156 376 200 V 348 H 324 V 236 L 256 288 L 188 236 V 348 H 136 Z"/><circle cx="256" cy="336" r="14" fill="#38bdf8"/></g>',
      'rgba(255,255,255,0.4)',
      ('#09090b', '#040405', '#000000')
    )
  },
  {
    'id': 'mx-26-negative-space-cutout',
    'title': '26. Negative Space Monolith',
    'category': 'solid',
    'catLabel': 'Solid & Ultra-Minimal',
    'tag': 'Inverted Negative Cut',
    'desc': '솔리드 사각형 면 내부에 네거티브 스페이스(음각)로 파인 하운드와 프롬프트 커서',
    'accent': '#ffffff',
    'svg': tile('mx26',
      '<linearGradient id="mx26-card" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#ffffff"/><stop offset="100%" stop-color="#e2e8f0"/></linearGradient>',
      '<g><rect x="96" y="96" width="320" height="320" rx="72" fill="url(#mx26-card)"/><path d="M 152 320 V 212 L 204 160 L 256 212 L 308 160 L 360 212 V 320" fill="none" stroke="#09090b" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"/><circle cx="256" cy="270" r="14" fill="#09090b"/></g>',
      '#ffffff'
    )
  },
  {
    'id': 'mx-27-stealth-blackout-matte',
    'title': '27. Stealth Blackout Matte',
    'category': 'solid',
    'catLabel': 'Solid & Ultra-Minimal',
    'tag': 'Quad-Shade Dark Titanium',
    'desc': '순수 다크 톤온톤 엠보싱. 빛의 반사각으로만 형상이 드러나는 절제된 스텔스 럭셔리',
    'accent': '#38bdf8',
    'svg': tile('mx27',
      '<linearGradient id="mx27-emboss" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#334155"/><stop offset="100%" stop-color="#1e293b"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 140 348 V 204 C 140 152 176 136 208 156 L 256 192 L 304 156 C 336 136 372 152 372 204 V 348" stroke="url(#mx27-emboss)" stroke-width="36"/><path d="M 196 280 L 256 340 L 316 280" stroke="#475569" stroke-width="28"/><circle cx="256" cy="246" r="8" fill="#38bdf8"/><circle cx="256" cy="246" r="3" fill="#ffffff"/></g>',
      '#38bdf8',
      ('#0c0d12', '#06070a', '#020204')
    )
  },
  {
    'id': 'mx-28-swiss-bauhaus-geometry',
    'title': '28. Swiss Bauhaus Reduction',
    'category': 'solid',
    'catLabel': 'Solid & Ultra-Minimal',
    'tag': 'Circle + Triangle + Rect',
    'desc': '바우하우스 3대 기본 도형(원, 삼각형, 사각형)만으로 강아지의 얼굴과 귀를 수학적으로 환원',
    'accent': '#f43f5e',
    'svg': tile('mx28',
      '<linearGradient id="mx28-red" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#be123c"/></linearGradient>',
      '<g><polygon points="128,260 200,140 200,260" fill="url(#mx28-red)"/><polygon points="384,260 312,140 312,260" fill="url(#mx28-red)"/><circle cx="256" cy="256" r="64" fill="#ffffff"/><polygon points="256,236 276,270 236,270" fill="#0f172a"/><rect x="224" y="324" width="64" height="24" rx="8" fill="url(#mx28-red)"/></g>',
      '#f43f5e'
    )
  },

  # 8. Experimental & Liquid
  {
    'id': 'mx-29-neon-plasma-ultraviolet',
    'title': '29. Ultraviolet Plasma Glow',
    'category': 'experimental',
    'catLabel': 'Experimental & Liquid',
    'tag': 'Electric Ultraviolet Neon',
    'desc': '칠흑 같은 어둠 속에서 발광하는 사이버펑크 네온 튜브 믹스독',
    'accent': '#c084fc',
    'svg': tile('mx29',
      '<linearGradient id="mx29-plasma" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#00f2fe"/><stop offset="50%" stop-color="#c084fc"/><stop offset="100%" stop-color="#f43f5e"/></linearGradient><filter id="mx29-glow"><feGaussianBlur stdDeviation="8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>',
      '<g filter="url(#mx29-glow)" fill="none" stroke="url(#mx29-plasma)" stroke-width="32" stroke-linecap="round" stroke-linejoin="round"><path d="M 136 348 V 204 C 136 150 174 130 206 152 L 256 190 L 306 152 C 338 130 376 150 376 204 V 348"/><path d="M 196 280 L 256 340 L 316 280" stroke="#ffffff" stroke-width="26"/></g><circle cx="256" cy="240" r="10" fill="#00f2fe"/>',
      '#c084fc'
    )
  },
  {
    'id': 'mx-30-frosted-glassmorphism',
    'title': '30. Apple Intelligence Frosted Glass',
    'category': 'experimental',
    'catLabel': 'Experimental & Liquid',
    'tag': 'Multi-Color Aurora Glass',
    'desc': '유리 질감의 반투명 굴절과 오로라 그라디언트 엣지. macOS Sequoia / 2026 차세대 인터페이스 룩',
    'accent': '#38bdf8',
    'svg': tile('mx30',
      '<linearGradient id="mx30-aurora" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="35%" stop-color="#818cf8"/><stop offset="70%" stop-color="#f43f5e"/><stop offset="100%" stop-color="#fbbf24"/></linearGradient><radialGradient id="mx30-glow" cx="50%" cy="40%" r="60%"><stop offset="0%" stop-color="#818cf8" stop-opacity="0.35"/><stop offset="100%" stop-color="#000000" stop-opacity="0"/></radialGradient>',
      '<circle cx="256" cy="240" r="160" fill="url(#mx30-glow)"/><g fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M 140 348 C 116 260 126 156 180 144 C 228 132 248 196 256 226 C 264 196 284 132 332 144 C 386 156 396 260 372 348" stroke="url(#mx30-aurora)" stroke-width="36"/><path d="M 196 276 L 256 336 L 316 276" stroke="#ffffff" stroke-width="28"/><circle cx="256" cy="286" r="7" fill="#38bdf8"/></g>',
      '#38bdf8'
    )
  },
  {
    'id': 'mx-31-windsurf-lane-cascade',
    'title': '31. Parallel Thread Cascade',
    'category': 'experimental',
    'catLabel': 'Experimental & Liquid',
    'tag': 'Multi-Lane Execution Bars',
    'desc': '3개의 병렬 실행 스레드 레인이 하운드의 기하학적 윤곽을 형성하는 멀티태스킹 아키텍처',
    'accent': '#34d399',
    'svg': tile('mx31',
      '<linearGradient id="mx31-c" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#38bdf8"/><stop offset="100%" stop-color="#0284c7"/></linearGradient><linearGradient id="mx31-e" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#34d399"/><stop offset="100%" stop-color="#059669"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="124" y="210" width="36" height="136" rx="18" fill="url(#mx31-c)"/><path d="M 176 196 C 176 160 204 144 228 168 L 244 186" stroke="#ffffff" stroke-width="32"/><path d="M 336 196 C 336 160 308 144 284 168 L 268 186" stroke="#ffffff" stroke-width="32"/><rect x="352" y="210" width="36" height="136" rx="18" fill="url(#mx31-e)"/><path d="M 194 280 L 256 342 L 318 280" stroke="#ffffff" stroke-width="32"/><circle cx="256" cy="236" r="8" fill="#34d399"/></g>',
      '#34d399'
    )
  },
  {
    'id': 'mx-32-tesseract-hypercube',
    'title': '32. 4D Tesseract Hypercube',
    'category': 'experimental',
    'catLabel': 'Experimental & Liquid',
    'tag': 'Multi-Dimensional Lattice',
    'desc': '4차원 초입방체(Hypercube) 격자 구조와 도그 이어의 결합. 극도로 지능적인 공간 컴퓨팅 무드',
    'accent': '#818cf8',
    'svg': tile('mx32',
      '<linearGradient id="mx32-tess" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#818cf8"/><stop offset="100%" stop-color="#c084fc"/></linearGradient>',
      '<g fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-width="18" stroke="url(#mx32-tess)"><polygon points="256,128 356,186 356,302 256,360 156,302 156,186"/><polygon points="256,186 306,215 306,273 256,302 206,273 206,215" stroke="#ffffff" stroke-width="12"/><line x1="256" y1="128" x2="256" y2="186" stroke="#ffffff" stroke-width="12"/><line x1="356" y1="186" x2="306" y2="215" stroke="#ffffff" stroke-width="12"/><line x1="356" y1="302" x2="306" y2="273" stroke="#ffffff" stroke-width="12"/><line x1="256" y1="360" x2="256" y2="302" stroke="#ffffff" stroke-width="12"/><line x1="156" y1="302" x2="206" y2="273" stroke="#ffffff" stroke-width="12"/><line x1="156" y1="186" x2="206" y2="215" stroke="#ffffff" stroke-width="12"/></g><circle cx="256" cy="244" r="8" fill="#ffffff"/>',
      '#818cf8'
    )
  }
]

# Write SVGs
for item in icons:
    path = os.path.join(icons_dir, item['id'] + '.svg')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(item['svg'])

print('Saved ' + str(len(icons)) + ' SVGs to ' + icons_dir)

# Build cards html
cards_html = []
for icon in icons:
    card = (
        '        <div class="icon-card" data-category="' + icon['category'] + '" data-id="' + icon['id'] + '">\n'
        '          <div class="preview-box">\n'
        '            ' + icon['svg'] + '\n'
        '          </div>\n'
        '          <div class="card-meta">\n'
        '            <span class="card-category">' + icon['catLabel'] + '</span>\n'
        '            <h3 class="card-title">' + icon['title'] + '</h3>\n'
        '            <span class="card-tag">' + icon['tag'] + '</span>\n'
        '            <p class="card-desc">' + icon['desc'] + '</p>\n'
        '          </div>\n'
        '          <div class="scale-row">\n'
        '            <div class="scale-item">\n'
        '              <div style="width: 48px; height: 48px;">' + icon['svg'] + '</div>\n'
        '              <span>48px</span>\n'
        '            </div>\n'
        '            <div class="scale-item">\n'
        '              <div style="width: 32px; height: 32px;">' + icon['svg'] + '</div>\n'
        '              <span>32px</span>\n'
        '            </div>\n'
        '            <div class="scale-item">\n'
        '              <div style="width: 20px; height: 20px;">' + icon['svg'] + '</div>\n'
        '              <span>20px</span>\n'
        '            </div>\n'
        '            <div class="scale-item">\n'
        '              <div style="width: 14px; height: 14px;">' + icon['svg'] + '</div>\n'
        '              <span>14px</span>\n'
        '            </div>\n'
        '          </div>\n'
        '          <div class="actions-row">\n'
        '            <a href="icons/' + icon['id'] + '.svg" download="' + icon['id'] + '.svg" class="action-btn btn-download" onclick="event.stopPropagation()">SVG 저장</a>\n'
        '            <button class="action-btn btn-copy" onclick="copySvg(\'' + icon['id'] + '\', event)">SVG 복사</button>\n'
        '          </div>\n'
        '        </div>\n'
    )
    cards_html.append(card)

json_data = json.dumps([{
  'id': i['id'],
  'title': i['title'],
  'catLabel': i['catLabel'],
  'tag': i['tag'],
  'desc': i['desc']
} for i in icons], ensure_ascii=False)

html_content = (
    '<!DOCTYPE html>\n'
    '<html lang="ko">\n'
    '<head>\n'
    '  <meta charset="UTF-8">\n'
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
    '  <title>Mixdog Mega Icon Master System (32 Variations)</title>\n'
    '  <link rel="preconnect" href="https://fonts.googleapis.com">\n'
    '  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
    '  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">\n'
    '  <style>\n'
    '    :root {\n'
    '      --bg: #07080c;\n'
    '      --card-bg: #0f1118;\n'
    '      --card-hover: #161924;\n'
    '      --border: rgba(255, 255, 255, 0.08);\n'
    '      --border-active: #38bdf8;\n'
    '      --text: #f8fafc;\n'
    '      --text-muted: #94a3b8;\n'
    '      --text-dim: #64748b;\n'
    '      --cyan: #38bdf8;\n'
    '      --amber: #fbbf24;\n'
    '      --violet: #c084fc;\n'
    '      --emerald: #34d399;\n'
    '      --rose: #f43f5e;\n'
    '    }\n'
    '    * { box-sizing: border-box; margin: 0; padding: 0; }\n'
    '    body {\n'
    '      background: var(--bg);\n'
    '      color: var(--text);\n'
    '      font-family: \'Plus Jakarta Sans\', -apple-system, BlinkMacSystemFont, \'Segoe UI\', Roboto, sans-serif;\n'
    '      min-height: 100vh;\n'
    '      line-height: 1.5;\n'
    '      padding-bottom: 120px;\n'
    '    }\n'
    '    .ambient-bg {\n'
    '      position: fixed;\n'
    '      top: 0; left: 0; right: 0; bottom: 0;\n'
    '      background:\n'
    '        radial-gradient(circle at 50% 0%, rgba(56, 189, 248, 0.12) 0%, transparent 50%),\n'
    '        radial-gradient(circle at 85% 30%, rgba(192, 132, 252, 0.08) 0%, transparent 45%),\n'
    '        radial-gradient(circle at 15% 60%, rgba(244, 63, 94, 0.06) 0%, transparent 40%);\n'
    '      pointer-events: none;\n'
    '      z-index: 0;\n'
    '    }\n'
    '    .container {\n'
    '      position: relative;\n'
    '      z-index: 1;\n'
    '      max-width: 1600px;\n'
    '      margin: 0 auto;\n'
    '      padding: 48px 32px;\n'
    '    }\n'
    '    header {\n'
    '      text-align: center;\n'
    '      max-width: 900px;\n'
    '      margin: 0 auto 36px;\n'
    '    }\n'
    '    .badge-pill {\n'
    '      display: inline-flex;\n'
    '      align-items: center;\n'
    '      gap: 8px;\n'
    '      padding: 6px 16px;\n'
    '      background: rgba(56, 189, 248, 0.1);\n'
    '      border: 1px solid rgba(56, 189, 248, 0.3);\n'
    '      border-radius: 999px;\n'
    '      color: var(--cyan);\n'
    '      font-size: 12px;\n'
    '      font-weight: 700;\n'
    '      letter-spacing: 0.08em;\n'
    '      text-transform: uppercase;\n'
    '      margin-bottom: 16px;\n'
    '    }\n'
    '    h1 {\n'
    '      font-size: 44px;\n'
    '      font-weight: 900;\n'
    '      letter-spacing: -0.03em;\n'
    '      background: linear-gradient(135deg, #ffffff 40%, #cbd5e1 75%, #94a3b8 100%);\n'
    '      -webkit-background-clip: text;\n'
    '      -webkit-text-fill-color: transparent;\n'
    '      margin-bottom: 12px;\n'
    '    }\n'
    '    header p {\n'
    '      color: var(--text-muted);\n'
    '      font-size: 16px;\n'
    '    }\n'
    '    .filters-bar {\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      justify-content: center;\n'
    '      flex-wrap: wrap;\n'
    '      gap: 10px;\n'
    '      margin-bottom: 40px;\n'
    '      position: sticky;\n'
    '      top: 16px;\n'
    '      z-index: 100;\n'
    '      background: rgba(7, 8, 12, 0.85);\n'
    '      backdrop-filter: blur(16px);\n'
    '      padding: 12px 20px;\n'
    '      border-radius: 16px;\n'
    '      border: 1px solid var(--border);\n'
    '    }\n'
    '    .filter-btn {\n'
    '      padding: 8px 18px;\n'
    '      border-radius: 10px;\n'
    '      font-size: 13px;\n'
    '      font-weight: 600;\n'
    '      background: transparent;\n'
    '      color: var(--text-muted);\n'
    '      border: 1px solid transparent;\n'
    '      cursor: pointer;\n'
    '      transition: all 0.15s ease;\n'
    '    }\n'
    '    .filter-btn:hover {\n'
    '      color: var(--text);\n'
    '      background: rgba(255, 255, 255, 0.05);\n'
    '    }\n'
    '    .filter-btn.active {\n'
    '      background: rgba(56, 189, 248, 0.15);\n'
    '      color: var(--cyan);\n'
    '      border-color: rgba(56, 189, 248, 0.4);\n'
    '    }\n'
    '    .icon-grid {\n'
    '      display: grid;\n'
    '      grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));\n'
    '      gap: 28px;\n'
    '    }\n'
    '    .icon-card {\n'
    '      background: var(--card-bg);\n'
    '      border: 1px solid var(--border);\n'
    '      border-radius: 24px;\n'
    '      padding: 24px;\n'
    '      display: flex;\n'
    '      flex-direction: column;\n'
    '      align-items: center;\n'
    '      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);\n'
    '      position: relative;\n'
    '      cursor: pointer;\n'
    '    }\n'
    '    .icon-card:hover {\n'
    '      transform: translateY(-4px);\n'
    '      background: var(--card-hover);\n'
    '      border-color: rgba(56, 189, 248, 0.4);\n'
    '      box-shadow: 0 20px 40px -10px rgba(0, 0, 0, 0.6);\n'
    '    }\n'
    '    .preview-box {\n'
    '      width: 220px;\n'
    '      height: 220px;\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      justify-content: center;\n'
    '      margin: 12px 0 20px;\n'
    '      filter: drop-shadow(0 16px 24px rgba(0, 0, 0, 0.7));\n'
    '      transition: transform 0.2s ease;\n'
    '    }\n'
    '    .icon-card:hover .preview-box {\n'
    '      transform: scale(1.04);\n'
    '    }\n'
    '    .preview-box svg {\n'
    '      width: 100%;\n'
    '      height: 100%;\n'
    '    }\n'
    '    .card-meta {\n'
    '      width: 100%;\n'
    '      text-align: left;\n'
    '      flex-grow: 1;\n'
    '      display: flex;\n'
    '      flex-direction: column;\n'
    '    }\n'
    '    .card-category {\n'
    '      font-size: 11px;\n'
    '      font-weight: 700;\n'
    '      text-transform: uppercase;\n'
    '      letter-spacing: 0.08em;\n'
    '      color: var(--cyan);\n'
    '      margin-bottom: 4px;\n'
    '    }\n'
    '    .card-title {\n'
    '      font-size: 17px;\n'
    '      font-weight: 700;\n'
    '      color: var(--text);\n'
    '      margin-bottom: 6px;\n'
    '    }\n'
    '    .card-tag {\n'
    '      font-family: \'JetBrains Mono\', monospace;\n'
    '      font-size: 11px;\n'
    '      color: var(--text-dim);\n'
    '      background: rgba(255, 255, 255, 0.04);\n'
    '      padding: 3px 8px;\n'
    '      border-radius: 6px;\n'
    '      display: inline-block;\n'
    '      margin-bottom: 10px;\n'
    '      width: fit-content;\n'
    '    }\n'
    '    .card-desc {\n'
    '      font-size: 12.5px;\n'
    '      color: var(--text-muted);\n'
    '      line-height: 1.5;\n'
    '      margin-bottom: 20px;\n'
    '      flex-grow: 1;\n'
    '    }\n'
    '    .scale-row {\n'
    '      width: 100%;\n'
    '      background: rgba(0, 0, 0, 0.35);\n'
    '      border: 1px solid rgba(255, 255, 255, 0.04);\n'
    '      border-radius: 12px;\n'
    '      padding: 10px 14px;\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      justify-content: space-around;\n'
    '      margin-bottom: 16px;\n'
    '    }\n'
    '    .scale-item {\n'
    '      display: flex;\n'
    '      flex-direction: column;\n'
    '      align-items: center;\n'
    '      gap: 4px;\n'
    '    }\n'
    '    .scale-item span {\n'
    '      font-size: 10px;\n'
    '      color: var(--text-dim);\n'
    '      font-family: \'JetBrains Mono\', monospace;\n'
    '    }\n'
    '    .actions-row {\n'
    '      width: 100%;\n'
    '      display: flex;\n'
    '      gap: 8px;\n'
    '    }\n'
    '    .action-btn {\n'
    '      flex: 1;\n'
    '      padding: 9px 12px;\n'
    '      border-radius: 10px;\n'
    '      font-size: 12px;\n'
    '      font-weight: 600;\n'
    '      text-align: center;\n'
    '      text-decoration: none;\n'
    '      cursor: pointer;\n'
    '      border: none;\n'
    '      transition: all 0.15s ease;\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      justify-content: center;\n'
    '      gap: 6px;\n'
    '    }\n'
    '    .btn-download {\n'
    '      background: rgba(255, 255, 255, 0.08);\n'
    '      color: var(--text);\n'
    '      border: 1px solid rgba(255, 255, 255, 0.1);\n'
    '    }\n'
    '    .btn-download:hover {\n'
    '      background: rgba(255, 255, 255, 0.15);\n'
    '    }\n'
    '    .btn-copy {\n'
    '      background: var(--cyan);\n'
    '      color: #000;\n'
    '    }\n'
    '    .btn-copy:hover {\n'
    '      background: #7dd3fc;\n'
    '    }\n'
    '    .modal-overlay {\n'
    '      position: fixed;\n'
    '      top: 0; left: 0; right: 0; bottom: 0;\n'
    '      background: rgba(0, 0, 0, 0.85);\n'
    '      backdrop-filter: blur(20px);\n'
    '      z-index: 1000;\n'
    '      display: none;\n'
    '      align-items: center;\n'
    '      justify-content: center;\n'
    '      padding: 24px;\n'
    '    }\n'
    '    .modal-overlay.active {\n'
    '      display: flex;\n'
    '    }\n'
    '    .modal-box {\n'
    '      background: #12141c;\n'
    '      border: 1px solid rgba(255, 255, 255, 0.15);\n'
    '      border-radius: 28px;\n'
    '      max-width: 900px;\n'
    '      width: 100%;\n'
    '      padding: 36px;\n'
    '      display: flex;\n'
    '      gap: 36px;\n'
    '      position: relative;\n'
    '      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.9);\n'
    '    }\n'
    '    .modal-close {\n'
    '      position: absolute;\n'
    '      top: 20px;\n'
    '      right: 20px;\n'
    '      background: rgba(255, 255, 255, 0.08);\n'
    '      border: none;\n'
    '      color: var(--text-muted);\n'
    '      width: 36px;\n'
    '      height: 36px;\n'
    '      border-radius: 50%;\n'
    '      font-size: 18px;\n'
    '      cursor: pointer;\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      justify-content: center;\n'
    '    }\n'
    '    .modal-close:hover {\n'
    '      background: rgba(255, 255, 255, 0.2);\n'
    '      color: #fff;\n'
    '    }\n'
    '    .modal-preview {\n'
    '      width: 320px;\n'
    '      height: 320px;\n'
    '      flex-shrink: 0;\n'
    '      filter: drop-shadow(0 24px 36px rgba(0,0,0,0.8));\n'
    '    }\n'
    '    .modal-preview svg { width: 100%; height: 100%; }\n'
    '    .modal-content {\n'
    '      display: flex;\n'
    '      flex-direction: column;\n'
    '      justify-content: center;\n'
    '      flex-grow: 1;\n'
    '    }\n'
    '    .modal-title {\n'
    '      font-size: 26px;\n'
    '      font-weight: 800;\n'
    '      margin-bottom: 8px;\n'
    '    }\n'
    '    .modal-desc {\n'
    '      color: var(--text-muted);\n'
    '      font-size: 14px;\n'
    '      line-height: 1.6;\n'
    '      margin-bottom: 24px;\n'
    '    }\n'
    '    .dock-simulation {\n'
    '      background: rgba(255, 255, 255, 0.04);\n'
    '      border: 1px solid rgba(255, 255, 255, 0.08);\n'
    '      border-radius: 16px;\n'
    '      padding: 16px 20px;\n'
    '      margin-bottom: 24px;\n'
    '    }\n'
    '    .dock-title {\n'
    '      font-size: 11px;\n'
    '      font-weight: 700;\n'
    '      text-transform: uppercase;\n'
    '      color: var(--text-dim);\n'
    '      margin-bottom: 12px;\n'
    '    }\n'
    '    .dock-bar {\n'
    '      display: flex;\n'
    '      align-items: center;\n'
    '      gap: 20px;\n'
    '    }\n'
    '  </style>\n'
    '</head>\n'
    '<body>\n'
    '  <div class="ambient-bg"></div>\n'
    '  <div class="container">\n'
    '    <header>\n'
    '      <div class="badge-pill">⚡ Mixdog Design System 2026</div>\n'
    '      <h1>Mixdog Master Icon Variations</h1>\n'
    '      <p>Paseo, Orca, Cursor, Linear 감성의 하이엔드 모던 테크 & 미니멀 앱 아이콘 32종</p>\n'
    '    </header>\n'
    '    <div class="filters-bar">\n'
    '      <button class="filter-btn active" data-cat="all">전체 (32종)</button>\n'
    '      <button class="filter-btn" data-cat="paseo">Paseo & Monoline</button>\n'
    '      <button class="filter-btn" data-cat="orca">Orca & Kinetic</button>\n'
    '      <button class="filter-btn" data-cat="linear">Linear & Cursor Facets</button>\n'
    '      <button class="filter-btn" data-cat="aperture">Multi-Model Aperture</button>\n'
    '      <button class="filter-btn" data-cat="terminal">Terminal Primitives</button>\n'
    '      <button class="filter-btn" data-cat="canine">Canine Cybernetics</button>\n'
    '      <button class="filter-btn" data-cat="solid">Solid & Minimal</button>\n'
    '      <button class="filter-btn" data-cat="experimental">Experimental & Liquid</button>\n'
    '    </div>\n'
    '    <div class="icon-grid" id="iconGrid">\n'
    + ''.join(cards_html) +
    '    </div>\n'
    '  </div>\n'
    '  <div class="modal-overlay" id="modalOverlay" onclick="closeModal(event)">\n'
    '    <div class="modal-box" onclick="event.stopPropagation()">\n'
    '      <button class="modal-close" onclick="closeModal(event)">✕</button>\n'
    '      <div class="modal-preview" id="modalSvg"></div>\n'
    '      <div class="modal-content">\n'
    '        <span class="card-category" id="modalCategory">CATEGORY</span>\n'
    '        <h2 class="modal-title" id="modalTitle">Icon Title</h2>\n'
    '        <span class="card-tag" id="modalTag">TAG</span>\n'
    '        <p class="modal-desc" id="modalDesc">Description</p>\n'
    '        <div class="dock-simulation">\n'
    '          <div class="dock-title">macOS Dock & Micro Scaling Test</div>\n'
    '          <div class="dock-bar">\n'
    '            <div style="width: 64px; height: 64px;" id="modalScale64"></div>\n'
    '            <div style="width: 48px; height: 48px;" id="modalScale48"></div>\n'
    '            <div style="width: 32px; height: 32px;" id="modalScale32"></div>\n'
    '            <div style="width: 16px; height: 16px;" id="modalScale16"></div>\n'
    '          </div>\n'
    '        </div>\n'
    '        <div class="actions-row">\n'
    '          <a id="modalDownload" href="#" download class="action-btn btn-download" style="padding: 12px 20px; font-size: 14px;">SVG 파일 다운로드</a>\n'
    '        </div>\n'
    '      </div>\n'
    '    </div>\n'
    '  </div>\n'
    '  <script>\n'
    '    const iconData = ' + json_data + ';\n'
    '    document.querySelectorAll(".filter-btn").forEach(btn => {\n'
    '      btn.addEventListener("click", () => {\n'
    '        document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));\n'
    '        btn.classList.add("active");\n'
    '        const cat = btn.getAttribute("data-cat");\n'
    '        document.querySelectorAll(".icon-card").forEach(card => {\n'
    '          if (cat === "all" || card.getAttribute("data-category") === cat) {\n'
    '            card.style.display = "flex";\n'
    '          } else {\n'
    '            card.style.display = "none";\n'
    '          }\n'
    '        });\n'
    '      });\n'
    '    });\n'
    '    document.querySelectorAll(".icon-card").forEach(card => {\n'
    '      card.addEventListener("click", () => {\n'
    '        const id = card.getAttribute("data-id");\n'
    '        const data = iconData.find(i => i.id === id);\n'
    '        const svgElement = card.querySelector(".preview-box svg").cloneNode(true);\n'
    '        document.getElementById("modalCategory").textContent = data.catLabel;\n'
    '        document.getElementById("modalTitle").textContent = data.title;\n'
    '        document.getElementById("modalTag").textContent = data.tag;\n'
    '        document.getElementById("modalDesc").textContent = data.desc;\n'
    '        document.getElementById("modalDownload").href = "icons/" + data.id + ".svg";\n'
    '        document.getElementById("modalDownload").download = data.id + ".svg";\n'
    '        const modalSvg = document.getElementById("modalSvg");\n'
    '        modalSvg.innerHTML = "";\n'
    '        modalSvg.appendChild(svgElement.cloneNode(true));\n'
    '        document.getElementById("modalScale64").innerHTML = "";\n'
    '        document.getElementById("modalScale64").appendChild(svgElement.cloneNode(true));\n'
    '        document.getElementById("modalScale48").innerHTML = "";\n'
    '        document.getElementById("modalScale48").appendChild(svgElement.cloneNode(true));\n'
    '        document.getElementById("modalScale32").innerHTML = "";\n'
    '        document.getElementById("modalScale32").appendChild(svgElement.cloneNode(true));\n'
    '        document.getElementById("modalScale16").innerHTML = "";\n'
    '        document.getElementById("modalScale16").appendChild(svgElement.cloneNode(true));\n'
    '        document.getElementById("modalOverlay").classList.add("active");\n'
    '      });\n'
    '    });\n'
    '    function closeModal(e) {\n'
    '      document.getElementById("modalOverlay").classList.remove("active");\n'
    '    }\n'
    '    function copySvg(id, e) {\n'
    '      e.stopPropagation();\n'
    '      const card = document.querySelector("[data-id=\"" + id + "\"]");\n'
    '      const svg = card.querySelector(".preview-box svg").outerHTML;\n'
    '      navigator.clipboard.writeText(svg).then(() => {\n'
    '        const btn = e.target;\n'
    '        const orig = btn.textContent;\n'
    '        btn.textContent = "복사 완료!";\n'
    '        btn.style.background = "#34d399";\n'
    '        setTimeout(() => {\n'
    '          btn.textContent = orig;\n'
    '          btn.style.background = "";\n'
    '        }, 1500);\n'
    '      });\n'
    '    }\n'
    '  </script>\n'
    '</body>\n'
    '</html>'
)

with open(os.path.join(out_dir, 'index.html'), 'w', encoding='utf-8') as f:
    f.write(html_content)

print('Generated full index.html gallery!')
