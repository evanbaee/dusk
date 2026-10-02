# Chrome 웹 스토어 등록 문구

개발자 대시보드에 그대로 붙여 넣으면 되는 문구입니다. 기본 언어는 영어(en), 한국어(ko)를 추가 언어로 등록하세요.
이름과 짧은 설명은 `_locales/*/messages.json`에서 자동으로 들어가므로 따로 입력하지 않아도 됩니다.

---

## 스토어 등록정보 (Store listing)

### 카테고리
`도구(Tools)` — 또는 `접근성(Accessibility)`

### 상세 설명 — 한국어

```
밤이 되면 모든 탭이 알아서 어두워져요.

다른 다크 모드 확장 프로그램처럼 색을 통째로 뒤집지 않아요. Dusk는 페이지마다 가장 자연스러운 방법을 골라요.

🌙 사이트 자체 다크 모드를 먼저 켜요
GitHub, MDN처럼 다크 테마가 있는 사이트는 그 사이트 디자이너가 만든 진짜 다크 테마로 바꿔요. 로고도 다크 버전으로 바뀌어요.

🖤 이미 어두운 사이트는 그대로 둬요
원래 어두운 사이트를 한 번 더 뒤집어서 밝게 망가뜨리는 일이 없어요.

🎨 나머지는 자연스럽게 변환해요
색을 하나하나 지각 색공간(OKLCH)에서 다시 계산해요. 배경은 어둡게, 글자는 밝게, 버튼과 브랜드 색은 색감을 유지한 채 읽기 좋은 밝기로. 사진은 손대지 않고, 투명 배경의 검은 로고는 보이도록 바꿔요.

⏰ 켜는 시간은 내가 정해요
아이콘을 눌러 켜는 시간과 끄는 시간을 정하세요(기본: 저녁 7시 ~ 아침 7시). 지금 당장 켜거나 끄고 싶으면 스위치 한 번이면 되고, 다음 스케줄부터는 다시 자동으로 돌아가요.

⚙️ 사이트별 설정
마음에 들지 않는 사이트는 '항상 변환' 또는 '원본 유지'로 바꿀 수 있어요.

⚡ 깜빡임 없이
밤에 새 페이지를 열 때 하얀 화면이 번쩍이지 않도록 첫 화면부터 어둡게 그려요. 켜고 끌 때는 화면이 부드럽게 전환돼요.

🔒 개인정보
어떤 데이터도 수집하거나 전송하지 않아요. 분석·광고·추적 코드가 없고 모든 처리는 내 브라우저 안에서만 이뤄져요.
```

### 상세 설명 — English

```
At night, every tab turns dark on its own.

Dusk doesn't just invert colors like other dark mode extensions. It picks the most natural approach for each page.

🌙 Uses the site's own dark theme first
Sites that ship a dark theme (GitHub, MDN and many more) switch to the real dark design their makers built — logos included.

🖤 Leaves already-dark sites alone
Dark sites are never flipped back to bright.

🎨 Converts the rest naturally
Every color is recomputed in a perceptual color space (OKLCH): backgrounds go dark, text goes light, and buttons and brand colors keep their hue at a readable brightness. Photos are untouched, and black logos on transparent backgrounds are made visible.

⏰ You set the hours
Click the icon to choose when dark mode turns on and off (default 7 PM – 7 AM). Flip the switch to override right now — the schedule takes over again at the next change.

⚙️ Per-site control
Set any site to "Always convert" or "Keep original".

⚡ No white flash
New pages are painted dark from the very first frame at night, and switching on or off cross-fades smoothly.

🔒 Private
Dusk collects and sends nothing. No analytics, ads or tracking — everything happens inside your browser.
```

### 그래픽 에셋 (모두 `assets/store/`에 있어요)
| 항목 | 파일 |
|---|---|
| 스토어 아이콘 128×128 | `store-icon-128.png` — 등록정보에서 직접 업로드해야 해요 |
| 스크린샷 1280×800 (최대 5장) | `ko-1-convert.png`, `ko-2-native.png`, `ko-3-dark.png`, `ko-4-popup.png` (영어: `en-*.png`) |
| 작은 프로모션 타일 440×280 | `promo-440x280.png` — 모든 언어 공통이라 글자 없이 이름만 넣었어요 |

스크린샷도 언어별로 따로 올릴 수 없으면, 주 사용자 언어 세트(`ko-*` 또는 `en-*`) 하나만 올리세요.

---

## 개인정보 보호 관행 (Privacy practices)

### 단일 목적 (Single purpose)
```
Dusk automatically switches web pages to a dark appearance during the hours the user chooses, preferring each site's own dark theme, leaving already-dark sites unchanged, and converting the remaining pages' colors.
```

### 권한별 사유 (Permission justification)

**storage**
```
Stores the user's settings (on/off, schedule times, per-site choices) and a small local cache of which sites are already dark, so pages can be darkened without a flash on the next visit. Nothing leaves the device.
```

**alarms**
```
Wakes the extension at the user's scheduled on/off times so dark mode starts and stops on time even when the browser has been idle.
```

**scripting**
```
Registers the early-loading stylesheet that paints pages dark before their own CSS loads (preventing a white flash at night) only while dark mode is active, and injects the content script into tabs that were already open when the extension was installed.
```

**Host permission (`<all_urls>`)**
```
Dusk restyles whatever page the user is viewing, so it must run on all sites. It reads the page's stylesheets to recompute their colors, and re-downloads cross-origin stylesheets and small logo images from the same servers the page uses so their colors can be analyzed. No page content is collected or transmitted to the developer or anyone else.
```

### 원격 코드 (Remote code)
`아니요, 원격 코드를 사용하지 않습니다 (No, I am not using remote code)`

### 데이터 사용 (Data usage)
- 수집하는 데이터 항목: **모두 체크하지 않음** (어떤 사용자 데이터도 수집하지 않음)
- 아래 세 가지 인증에 모두 체크:
  - 승인된 사용 사례 외의 목적으로 제3자에게 사용자 데이터를 판매하거나 전송하지 않음
  - 항목의 단일 목적과 관련 없는 목적으로 사용자 데이터를 사용하거나 전송하지 않음
  - 신용도 판단 또는 대출 목적으로 사용자 데이터를 사용하거나 전송하지 않음

### 개인정보처리방침 URL
`PRIVACY.md`를 공개 URL에 올린 뒤 그 주소를 입력하세요 (아래 PUBLISHING.md 참고).
