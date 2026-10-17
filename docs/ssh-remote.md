# SSH 서버 연결

Mixdog 데스크톱 앱에서 SSH로 접속할 수 있는 원격 서버(리눅스 서버, 클라우드 VM, 개발용 맥 등)의 파일과 터미널로 작업할 수 있습니다. 서버에는 Mixdog을 미리 설치할 필요가 없습니다. 처음 연결할 때 앱이 필요한 파일을 서버의 홈 폴더 안에 직접 설치합니다.

> English summary: [at the end of this page](#english-summary).

## 목차

- [무엇인가요](#무엇인가요)
- [준비물](#준비물)
- [연결하는 방법](#연결하는-방법)
- [처음 연결할 때의 지문 확인](#처음-연결할-때의-지문-확인)
- [로그인: 키, 암호, ssh-agent, 비밀번호, 인증 코드](#로그인-키-암호-ssh-agent-비밀번호-인증-코드)
- [경유 서버(ProxyJump)](#경유-서버proxyjump)
- [서버에 설치되는 것](#서버에-설치되는-것)
- [보안 구조](#보안-구조)
- [서버 창에서 작업하기](#서버-창에서-작업하기)
- [포트 전달](#포트-전달)
- [연결이 끊어졌을 때](#연결이-끊어졌을-때)
- [서버별 설정](#서버별-설정)
- [진단](#진단)
- [문제 해결](#문제-해결)
- [서버에서 Mixdog 지우기](#서버에서-mixdog-지우기)

## 무엇인가요

SSH 서버 연결은 **내 PC의 Mixdog 창에서 원격 서버를 열어 쓰는 기능**입니다. 서버 창에서는 다음과 같이 동작합니다.

- 프로젝트 파일, 편집기, 터미널, Git은 **서버에 있는 것**을 사용합니다.
- AI 모델 호출은 **내 PC의 로그인**으로 처리합니다. 서버에 API 키나 계정 정보를 저장하지 않습니다.
- 창을 닫거나 연결이 끊어져도 서버에서 진행 중이던 작업은 계속됩니다. 다시 연결하면 이어서 볼 수 있습니다.

**다른 PC 열기와의 차이**

| | SSH 서버 | 다른 PC 열기 |
| --- | --- | --- |
| 연결 방식 | SSH(OpenSSH) | 코드로 연결 |
| 상대방 | SSH로 접속되는 서버 | Mixdog 데스크톱 앱이 켜져 있는 다른 PC |
| 상대방에 필요한 것 | sshd와 Node.js (Mixdog은 자동 설치) | Mixdog 앱 |
| 모델 호출 | 내 PC의 로그인 사용 | 상대 PC의 Mixdog이 처리 |

설정 → 연결에서 두 기능을 모두 찾을 수 있습니다.

## 준비물

**서버**

- 운영체제: Linux(x64 또는 arm64, glibc 기반) 또는 macOS(x64 또는 arm64). Windows 서버와 Alpine 같은 musl 기반 리눅스는 지원하지 않습니다.
- **Node.js 22 이상**과 **npm**
- npm 레지스트리에 접속할 수 있어야 하며, 모듈 하나는 github.com에서 받을 수 있습니다. 서버가 인터넷에 접속하지 못하면 설치가 실패합니다.
- 실행 중인 sshd. 관리자(root) 권한은 필요하지 않습니다.

**내 PC**

- OpenSSH 클라이언트(`ssh`, `ssh-keygen`, `ssh-keyscan`). macOS와 Linux에는 보통 이미 있습니다. Windows 10/11에서는 "선택적 기능"의 OpenSSH 클라이언트가 필요하며, 없으면 앱이 설치 명령을 안내합니다.
- 서버에 로그인할 수 있는 SSH 키 또는 계정

## 연결하는 방법

1. 설정 → 연결에서 **SSH 서버 연결**을 누릅니다.
2. `user@서버 주소`를 입력합니다. 포트가 22가 아니면 `user@서버 주소:2222`처럼 씁니다. `~/.ssh/config`에 등록한 별칭(Host)도 입력창 아래 목록에 나타나며, 그대로 선택하면 됩니다.
3. **연결**을 누릅니다. 처음 접속하는 서버라면 [지문 확인](#처음-연결할-때의-지문-확인) 창이 먼저 나타납니다.
4. 진행 상황이 차례로 표시됩니다.
   1. **서버 접속**: SSH로 서버에 접속합니다.
   2. **서버 확인**: 서버의 운영체제와 Node.js 버전을 확인합니다.
   3. **Mixdog 설치**: 처음 연결할 때와 앱을 업데이트해 새 버전을 설치해야 할 때 표시되며 1분 정도 걸립니다. 같은 버전이 이미 설치되어 있으면 이 단계는 건너뜁니다.
   4. **연결**: 서버의 Mixdog에 붙습니다.
5. 서버 창이 열리고, 서버가 목록에 저장됩니다. 다음부터는 목록에서 바로 열 수 있습니다.

실패하면 원인과 해결 방법이 같은 창에 표시됩니다. [문제 해결](#문제-해결)에서 자세히 설명합니다. 앱은 실패한 연결을 혼자 되풀이해서 시도하지 않으므로, 원인을 고친 뒤 **다시 시도**를 누르면 됩니다.

## 처음 연결할 때의 지문 확인

처음 접속하는 서버에서는 "처음 연결하는 서버입니다" 창이 나타나고 서버의 **지문**(`SHA256:…`)과 키 **방식**이 표시됩니다.

- 지문은 서버가 "내가 진짜 이 서버다"라고 내보이는 신분증과 같습니다. 서버 관리자나 클라우드 제공업체의 대시보드에서 확인한 지문과 같을 때만 **연결**을 누르십시오. 직접 관리하는 서버가 아니라면 연결하지 마십시오.
- **연결**을 누르기 전에는 아무것도 저장하지 않습니다. 누르면 그 지문이 Mixdog 전용 `known_hosts`에 기록되고, 이후에는 같은 서버에서 다시 묻지 않습니다.
- 나중에 지문이 달라지면 연결하지 않고 "서버 지문이 바뀌었습니다" 창을 보여 줍니다. 서버를 다시 설치한 경우일 수도 있지만 다른 컴퓨터가 서버인 척하는 경우일 수도 있으므로, 서버 관리자에게 먼저 확인하십시오. 이유를 알고 있고 키가 Mixdog 전용 파일에 있는 경우에 한해 **고급 · 키 교체**로 서버 이름을 직접 입력해 교체할 수 있습니다. 직접 지우려면 창에 표시되는 `ssh-keygen -R …` 명령을 이 PC 터미널에서 실행하십시오.
- `known_hosts`에 폐기(revoked)로 표시된 키라면 "이 서버의 키는 폐기되었습니다"라고 알리고 연결하지 않습니다.

## 로그인: 키, 암호, ssh-agent, 비밀번호, 인증 코드

Mixdog은 내 PC의 OpenSSH를 그대로 사용하므로 평소 터미널에서 `ssh user@서버`로 접속되는 방식이 대부분 그대로 동작합니다. `~/.ssh/config`의 설정도 따릅니다.

먼저 묻지 않고(`BatchMode`) 접속을 시도하고(키 파일, ssh-agent), 로그인이 거절되면 같은 연결 창에서 한 번 더 물어봅니다. 자동 재연결 같은 백그라운드 연결은 묻지 않으므로 로그인 입력이 필요하면 멈추고, **다시 연결**을 눌러 연결 창에서 입력해야 합니다.

| 묻는 내용 | 언제 | 비고 |
| --- | --- | --- |
| **키 암호** | 암호로 보호된 개인 키를 쓸 때 | ssh-agent에 키를 올려 두면 묻지 않습니다. |
| **서버 암호** | 비밀번호 로그인만 허용되는 서버 | |
| **인증 코드** | 2단계 인증(OTP)을 쓰는 서버 | |

- 입력한 값은 **이번 연결에만 사용하고 저장하지 않습니다.** 2분 안에 입력하지 않으면 취소됩니다.
- 로그인용 키가 없다면 창에 키 만들기와 서버에 등록하는 명령이 순서대로 나타납니다(`ssh-keygen -t ed25519`, 이어서 `ssh-copy-id …`. Windows에서는 공개 키를 `ssh`로 서버의 `authorized_keys`에 붙이는 PowerShell 명령). 이 PC 터미널에서 실행한 뒤 **다시 시도**하십시오.
- **ssh-agent**가 꺼져 있거나 키가 없으면 그 상태에 맞는 시작 명령도 함께 안내합니다. 암호가 있는 키를 매번 입력하기 싫다면 ssh-agent를 쓰십시오.
- 기본이 아닌 키 파일을 쓰려면 서버별 설정의 [로그인 키 파일](#서버별-설정)에 경로를 지정하십시오. 이 경우 Mixdog은 그 키만 사용합니다.

## 경유 서버(ProxyJump)

`~/.ssh/config`에 `ProxyJump`(또는 `ProxyCommand`)가 있는 서버도 연결할 수 있습니다.

- 경유 호스트마다 지문을 확인합니다. 앞쪽 호스트를 먼저 신뢰한 뒤에 다음 서버의 지문을 읽어 오므로, 지문 확인 창에 "경유 호스트 …", "서버 …"가 차례로 나타나며 하나씩 연결을 눌러 확인합니다.
- ssh 설정에 `LocalForward` 같은 포트 포워딩이 있어도 Mixdog은 보통 그것을 제외한 설정으로 접속합니다. 제외할 수 없을 때만 "ssh 설정에 포트 포워딩이 있습니다"라고 알리고, **계속**을 누르면 연결되어 있는 동안 그 포워딩도 함께 동작합니다.

## 서버에 설치되는 것

모든 파일은 접속한 계정의 홈 폴더 아래 **`~/.mixdog-remote`** 에만 둡니다. 시스템 폴더에 쓰지 않고 서비스(systemd 등)도 등록하지 않으며 root 권한도 쓰지 않습니다.

```text
~/.mixdog-remote/
├── versions/<버전-해시>/   설치된 Mixdog 실행 파일 (앱 버전마다 별도 폴더, 설치 후 바뀌지 않음)
├── deps/                   Mixdog이 쓰는 Node 모듈
├── runtime/                실행 중인 Mixdog의 접속 정보 (포트, 토큰)
├── user-data/              서버 쪽 설정과 작업 기록 (home/ 아래)
├── daemon.log              서버 Mixdog의 로그 (5MB를 넘으면 daemon.log.1로 복사한 뒤 비움)
├── daemon.log.1            직전 로그 한 세대
├── state.json              현재/이전 설치 버전 기록
└── .install-lock           설치 중에만 쓰는 잠금 파일
```

- 앱을 업데이트해서 새 버전을 연결하면 `versions/` 아래에 새 폴더가 생깁니다. 설치할 때 오래된 폴더가 자동으로 정리되는데, **현재와 직전 버전**, 그리고 **실행 중인 프로세스가 쓰고 있는 버전**은 남깁니다. 서버의 프로세스 목록을 읽지 못하면 안전을 위해 아무것도 지우지 않습니다. `user-data`는 버전과 무관하게 유지됩니다.
- `daemon.log`가 5MB를 넘으면 `daemon.log.1`로 복사한 뒤 원래 파일을 비웁니다(한 세대만 보관). 실행 중인 서버 Mixdog은 중단 없이 계속 기록합니다.
- 설치할 때 쓰는 `npm`은 자체 다운로드 캐시(보통 `~/.npm`)를 만들 수 있습니다. 이 폴더는 npm이 관리하며 Mixdog 정리 대상이 아닙니다.
- 서버의 Mixdog은 백그라운드 프로세스(Node.js)로 실행되며, 사용자가 직접 설치해 쓰는 Mixdog과 완전히 분리되어 있습니다(별도의 데이터 폴더와 접속 정보를 씁니다).

## 보안 구조

- **서버의 Mixdog은 서버 안에서만 열려 있습니다.** `127.0.0.1`(루프백)에서만 접속을 받으며 외부 네트워크에 포트를 열지 않습니다. 내 PC에서는 SSH 터널(`ssh -L`)로 그 포트에 닿고, 접속에는 서버의 Mixdog이 만든 **토큰**이 필요합니다. 토큰은 서버의 `runtime/` 파일에 있고 SSH로 읽어 오며, 내 PC의 디스크에 저장하지 않고 메모리에만 둡니다.
- **토큰을 보내기 전에 상대를 확인합니다.** 터널 끝에서 응답하는 프로세스가 방금 확인한 Mixdog(프로세스 번호와 빌드)인지 먼저 확인하고, 다르면 연결을 멈춥니다. 같은 서버를 쓰는 다른 사용자가 포트를 가로채는 경우를 막기 위한 것입니다.
- **모델은 내 PC의 로그인으로 실행됩니다.** 서버의 Mixdog은 모델 호출을 내 PC로 보내 달라고 요청하는 모드로만 연결됩니다. 이 모드가 아닌 Mixdog이 서버에서 돌고 있으면 서버의 계정 정보로 모델이 실행될 수 있어 연결하지 않습니다. 서버는 **연결되어 있는 동안에만** 내 계정을 사용합니다.
- **서버별로 허용할 모델 제공자를 정할 수 있습니다.** [서버별 설정](#서버별-설정)의 "이 서버가 쓸 수 있는 모델"에서 고릅니다. 기본값은 이 PC에서 사용 설정된 모든 제공자입니다.
- **서버가 내 PC의 모델을 부르는 방식에는 안전장치가 있습니다.** 서버가 내 계정을 마음대로 쓰지 못하도록 내 PC가 다음을 지킵니다.
  - **서버가 연결되어 있는 동안에는 모델 호출을 내 PC에서 로컬과 똑같이 처리합니다.** 모델 호출 횟수, 토큰 총량, 시간, 속도, 동시 호출 수, 한 번의 호출 시간에 따로 상한을 두지 않습니다. 예약·웹훅·백그라운드 작업이나 자동 재개도 서버가 연결되어 있으면 그대로 실행됩니다. 연결이 끊기면 진행 중이던 호출도 함께 취소됩니다.
  - 호출 하나의 크기는 **128 MiB**까지, 서버 하나가 동시에 올려 두는 호출 데이터는 합계 **256 MiB**까지만 받습니다. 넘으면 그 호출만 거절합니다.
  - 모델 목록과 사용 가능 여부 확인도 같은 방식으로 처리합니다.
  - **덜 신뢰하는 서버에는** [서버별 설정](#서버별-설정)에서 "이 서버가 쓸 수 있는 모델"을 필요한 제공자로 좁히십시오.
  - 허용하지 않은 제공자의 호출은 처리하지 않습니다.
  - 서버는 **이 PC에 저장된 첨부 파일을 읽을 수 없습니다.** 서버가 대화에 직접 담아 보낸 내용만 모델에 전달되고, 이 PC의 첨부 저장소를 가리키는 항목은 "[attachment unavailable: …]" 문구로 바뀝니다.
- **에이전트·X11 포워딩은 끕니다.** Mixdog이 실행하는 모든 `ssh`에는 `ForwardAgent=no`, `ForwardX11=no`가 붙으므로, 내 ssh-agent의 키나 화면이 서버로 넘어가지 않습니다. 그 외에는 호스트 키를 엄격하게 확인하고(`StrictHostKeyChecking=yes`) 묻지 않는 모드(`BatchMode=yes`)로 접속합니다. 처음 시도와 백그라운드 연결(자동 재연결, 앱 시작 시 서버 창 다시 열기)은 항상 이 모드입니다. 로그인 거절 뒤 사용자가 직접 **다시 시도**를 누른 연결에서만 암호·비밀번호·인증 코드를 묻는 입력창(askpass)을 허용합니다.
- **Mixdog 전용 `known_hosts`를 씁니다.** 새로 확인한 지문은 앱 데이터 폴더의 `ssh/known_hosts`에만 기록하며, `~/.ssh/known_hosts`는 읽기만 하고 수정하지 않습니다.
- 주의: 서버 창의 에이전트는 **접속한 계정의 권한**으로 서버에서 명령을 실행하고 파일을 고칩니다. 평소 터미널로 SSH 접속해서 할 수 있는 일은 모두 할 수 있다고 생각하십시오.

## 서버 창에서 작업하기

서버 창에는 "모델: 이 PC 로그인 · 파일·도구: 서버 이름"이라는 안내가 있어 모델과 도구가 어디서 동작하는지 알려 줍니다.

- **파일**: 파일 트리, 편집기, 검색, Git이 모두 서버의 파일을 대상으로 합니다. 프로젝트 폴더도 서버의 폴더에서 고릅니다(기본 폴더는 서버별 설정에서 정합니다).
- **터미널**: 서버에서 실행되는 터미널입니다. 서버에서 터미널을 쓸 수 없으면 "이 서버에서는 터미널을 쓸 수 없습니다"라고 표시되고 나머지 기능은 그대로 쓸 수 있습니다.
- **첨부 파일**: 이 PC의 파일을 첨부하거나 끌어다 놓으면 서버의 첨부 폴더로 올라간 뒤 대화에 쓰입니다. 올릴 수 있는 크기에 한도가 있으며, 넘으면 안내가 표시됩니다.
- **미리보기·내려받기**: 서버의 이미지, HTML 등은 서버에서 바로 읽어 미리 볼 수 있고, "이 PC로 내려받아 열기"로 내 PC에 복사해 열 수 있습니다.
- **쓸 수 없는 기능**: 아래 기능은 내 PC 자체를 조작하므로 서버 창에서는 막혀 있고, 누르면 이유가 안내됩니다. 해당 기능이 필요하면 내 PC의 창에서 사용하십시오.
  - Computer Use(PC 화면·입력 제어), 브라우저 창, 휴대전화 연결
  - 데스크톱 앱 업데이트, 알림음 미리듣기
  - 내 PC의 폴더를 서버 프로젝트로 여는 기능(대신 서버의 폴더를 고르거나 파일을 첨부해 올립니다)
  - 서버 파일을 내 PC의 탐색기나 기본 앱으로 바로 여는 기능(대신 파일 트리에서 찾거나 "이 PC로 내려받아 열기"를 씁니다)
- 알림, 업데이트, 모델 로그인은 내 PC 설정을 따릅니다.

## 포트 전달

서버에서 웹 개발 서버(예: 3000번)를 띄웠다면, 그 포트를 **내 PC로 전달**해서 내 PC의 브라우저로 열 수 있습니다.

**패널 위치**: 서버 창 왼쪽 레일에서 **더 보기**를 누르면 나오는 메뉴의 **포트**입니다. 서버 창에서만 쓸 수 있습니다.

**서버에서 열린 포트 목록**
- 패널이 보이는 동안 **5초마다** 서버를 다시 확인합니다. **포트 다시 확인**으로 바로 갱신할 수도 있습니다. 연결이 끊어져 있으면 확인을 멈췄다가 다시 연결되면 이어서 확인합니다.
- 포트마다 번호, 주소, 그 포트를 연 **프로세스 이름**이 표시됩니다. 접속한 계정이 볼 수 있는 프로세스만 이름이 나타나고, 그렇지 않으면 "포트 3000"처럼 번호만 보입니다. 서버에서 Mixdog 자신이 쓰는 포트는 목록에 나오지 않습니다.
- 서버가 Linux나 macOS일 때 확인합니다(macOS에서는 `lsof`를 사용합니다).

**전달하기**
1. 목록에서 포트의 **전달**을 누릅니다. 목록에 없는 포트는 **포트 전달**(+)에서 서버 포트 번호를 직접 입력하고, 필요하면 "이 PC 포트"도 정합니다.
2. 내 PC 쪽 포트는 따로 정하지 않으면 **서버와 같은 번호**를 쓰고, 그 번호가 1024 미만이거나 이미 사용 중이면 비어 있는 아무 포트를 씁니다. 직접 정한 포트가 1024 미만이거나 사용 중이면 오류로 알려 주고 전달하지 않습니다.
3. 전달되면 "전달된 포트"에 `서버 포트 → 내 PC 포트`로 표시되고 상태가 "전달 중"이 됩니다. 이제 내 PC의 `127.0.0.1:포트`로 접속할 수 있습니다. 내 PC의 `127.0.0.1`에서만 열리므로 같은 네트워크의 다른 컴퓨터는 접속할 수 없습니다.
4. **브라우저에서 열기**(↗)를 누르면 `http://127.0.0.1:<내 PC 포트>/`를 기본 브라우저로 엽니다. **전달 중지**(■)를 누르면 전달을 끝냅니다.

**새 포트 제안**
- 서버에서 새로 열린 포트가 감지되면 "서버 이름에서 새 포트를 감지했습니다"라는 제안이 나타납니다. **전달**을 누르면 전달하고, **무시**를 누르면 그 포트의 제안을 더 보이지 않습니다.
- 제안만 할 뿐 **절대 저절로 전달하지 않습니다.** 패널을 처음 확인할 때 이미 열려 있던 포트는 제안하지 않습니다.

**저장과 복원**
- 전달 목록은 서버별로 저장됩니다. 연결이 끊겼다가 다시 연결되거나 앱을 다시 켜서 서버에 연결하면 저장된 포트를 자동으로 다시 전달합니다. 이전에 쓰던 내 PC 포트를 우선 쓰고, 이미 사용 중이면 다른 포트를 씁니다.
- 서버 창을 닫으면 전달은 멈추지만 저장된 목록은 남습니다. 전달을 끝내려면 **전달 중지**를 누르십시오.

**제한 사항**
- 전달에는 **키 파일(또는 ssh-agent)로 로그인되는 서버**만 쓸 수 있습니다. 포트 전달은 비밀번호나 인증 코드를 물어볼 수 없으므로, 비밀번호·OTP로만 로그인되는 서버에서는 전달이 실패합니다.
- 전달은 서버의 `127.0.0.1:포트`로 연결합니다. **`::1`(IPv6 루프백)에만 열려 있는 서비스는 응답하지 않습니다.** 서비스를 `127.0.0.1` 또는 모든 주소(`0.0.0.0`)에서 받도록 설정하십시오.
- 서버의 SSH 설정이 TCP 포워딩을 막고 있으면(`AllowTcpForwarding no`) 전달할 수 없습니다.

## 연결이 끊어졌을 때

노트북이 절전에서 깨어나거나 Wi-Fi가 바뀌면 연결이 끊어질 수 있습니다.

- 연결이 끊기면 서버 창 위쪽에 "{서버 이름}에 다시 연결하는 중입니다 (N번째 시도)"와 "N초 후 다시 시도합니다"(진행 중이면 "지금 시도하고 있습니다…") 카운트다운이 표시되고 앱이 **자동으로 다시 연결**합니다. 시도 간격은 1초에서 시작해 점점 길어지며 최대 30초입니다. 이 PC가 절전 중일 때는 실패로 치지 않고 잠시 멈춰 있다가 깨어나면 다시 확인합니다.
- 카운트다운 중에는 **지금 다시 연결**을 눌러 기다리는 시도를 바로 실행할 수 있습니다. 이후 간격은 원래 순서대로 계속되고, 유지 시간(아래) 계산도 그대로입니다. **로그 보기**로 원인을 볼 수 있습니다.
- 자동 재연결을 멈추면 "{서버 이름} 연결이 끊겼습니다"로 바뀌고, 이때만 **다시 연결**과 **창 닫기** 버튼이 나타납니다. 다시 로그인이나 확인이 필요한 경우 **다시 연결**은 이 PC 창의 연결 창을 열어 줍니다.
- **서버의 작업은 계속됩니다.** 연결이 끊어진 동안에도 서버의 Mixdog은 하던 일을 진행합니다. 다시 연결되면 "서버에서 끝난 작업"과 "계속 진행 중인 작업"을 알려 줍니다. 단, 끊어질 때 진행 중이던 모델 호출은 내 PC를 거치므로 중단되며 자동으로 다시 시도하지 않습니다.
- **유지 시간(grace time)**: 내 PC가 사라진 뒤 서버가 Mixdog을 켜 둔 채 기다리는 시간입니다. 기본 30분이며 서버별 설정에서 1분~7일로 바꿀 수 있습니다. 이 시간 안에 다시 연결되면 같은 Mixdog에 그대로 이어서 붙습니다. 변경한 값은 서버의 Mixdog이 새로 시작될 때부터 적용됩니다.
- 사람이 해결해야 하는 문제(서버 지문 변경, 로그인 거절, 서버의 Node.js 문제 등)는 자동으로 다시 시도하지 않고 멈춥니다. 안내에 따라 해결한 뒤 설정 → 연결에서 다시 연결하십시오.
- 로그인한 모델 계정이 만료되면 "이 PC의 모델 로그인이 만료되었습니다"라고 알립니다. 서버가 아니라 **내 PC 창**의 설정 → 모델에서 다시 로그인하십시오.
- **호출 크기 제한**: 호출 하나가 128 MiB를 넘거나 서버가 동시에 올린 호출 데이터가 256 MiB를 넘으면 그 호출만 거절됩니다. 자세한 기준은 [보안 구조](#보안-구조)를 참고하십시오.

## 서버별 설정

설정 → 연결의 서버 목록에서 서버의 설정을 열 수 있습니다("서버 이름 설정"). 변경 사항은 **다음 연결부터** 적용됩니다.

| 항목 | 설명 |
| --- | --- |
| 기본 서버 폴더 | 서버 창이 처음 여는 폴더입니다. `~`, `~/work` 또는 절대 경로. 비우면 홈 폴더입니다. |
| 로그인 키 파일 | 이 서버에 쓸 개인 키 파일의 경로(`ssh -i`). 비우면 평소 ssh 설정과 ssh-agent를 따릅니다. |
| 연결이 끊어지면 자동으로 다시 연결 | 끄면 연결이 끊긴 뒤 직접 **다시 연결**을 누를 때까지 가만히 있습니다. |
| 연결이 끊긴 뒤 서버 작업 유지 시간(분) | 위의 유지 시간. 기본 30분. |
| 이 서버가 쓸 수 있는 모델 | 서버가 내 PC의 로그인으로 쓸 수 있는 모델 제공자. 기본은 이 PC에서 켠 모든 제공자. |

앱 설정에는 "앱을 켤 때 서버 창 다시 열기"도 있습니다. 켜 두면 종료할 때 열려 있던 서버 창을 다음 실행 때 백그라운드로 다시 엽니다. 이 자동 연결은 묻지 않는 모드이므로, 비밀번호가 필요한 서버는 설정에서 직접 연결해야 합니다.

## 진단

연결이 안 될 때는 다음 세 가지를 쓰십시오.

- **로그 보기**: 이번 연결에서 실행한 ssh 명령과 진행 단계의 기록입니다. 연결 실패 창과 서버 창의 연결 끊김 표시줄에서 열 수 있습니다.
- **진단 정보 복사**: 앱 버전, ssh 버전, ssh가 해석한 접속 설정(HostName, User, Port, ProxyJump 여부)과 위 로그를 한 번에 복사합니다. 이슈를 올릴 때 붙여 넣으십시오.
- **서버 로그 가져오기**: 서버의 `~/.mixdog-remote/daemon.log` 마지막 200줄을 가져옵니다. 서버의 Mixdog이 시작하지 못하거나 응답하지 않을 때 원인이 담겨 있습니다.

**무엇이 가려지나요?**
- 토큰, 비밀번호, 긴 비밀 값처럼 비밀로 보이는 값은 화면에 보이는 로그에서도 이미 지워져 있습니다.
- 화면에 보이는 로그 본문에서는 **서버 주소와 사용자 이름이 가려지지 않습니다.**
- **복사**와 **진단 정보 복사**로 클립보드에 넣을 때만 서버 주소와 사용자 이름이 `<server>`로 바뀝니다. 이름이 짧으면(3자 이하) 일반 단어를 건드리지 않도록 `user@host` 형태일 때만 바뀝니다.
- 그래도 내용이 완전히 가려진다고 보장하지는 않으므로, 대화창에 안내된 대로 **공유하기 전에 내용을 직접 확인하십시오.**

## 문제 해결

연결에 실패한 창에는 모두 "오류 코드: …" 줄이 표시됩니다(로그인, 지문 변경·폐기, OpenSSH 없음 포함). 아래 표는 그 코드를 기준으로 정리했습니다. "서버에 Node.js 22가 필요합니다"(`node-missing`, `node-too-old`)는 서버에서 Mixdog을 정리할 때도 나타납니다.

| 증상 / 코드 | 원인 | 해결 |
| --- | --- | --- |
| OpenSSH가 설치되어 있지 않습니다 (`ssh-missing`) | 내 PC에 `ssh`가 없거나 PATH에 없습니다. | macOS/Linux는 패키지 관리자로 OpenSSH 클라이언트를 설치합니다. Windows는 창에 표시되는 관리자 PowerShell 명령으로 OpenSSH 클라이언트를 추가합니다. |
| 로그인할 수 없습니다 (`auth`) | 서버에 내 키가 등록되어 있지 않거나, 키·비밀번호가 거절되었습니다. | 창의 명령으로 키를 만들고(`ssh-keygen -t ed25519`) 서버에 등록(`ssh-copy-id`)합니다. 키가 여러 개면 서버 설정의 "로그인 키 파일"을 지정하고, ssh-agent 안내가 있으면 따릅니다. |
| 서버 지문이 바뀌었습니다 (`host-key-changed`) | 저장된 지문과 서버가 내놓는 지문이 다릅니다. 서버 재설치일 수도, 가로채기일 수도 있습니다. | 서버 관리자에게 확인합니다. 정상이라면 `ssh-keygen -R …`로 이전 키를 지우거나, Mixdog 전용 파일의 키라면 "고급 · 키 교체"를 씁니다. |
| 이 서버의 키는 폐기되었습니다 (`host-key-revoked`) | `known_hosts`가 이 키를 폐기(revoked)로 표시했습니다. | 서버 관리자에게 새 키를 받습니다. |
| 서버에 Node.js 22가 필요합니다 (`node-missing`, `node-too-old`) | 서버에 Node.js가 없거나 22보다 낮습니다. 창에 찾은 버전이 표시됩니다. | 서버 터미널에서 창에 표시된 명령(`curl -fsSL https://fnm.vercel.app/install \| bash && fnm install 22`)을 실행하거나 Node.js 22 이상을 설치합니다. 비대화형 SSH에서도 `node`가 PATH에 잡혀야 합니다. |
| 서버에 npm이 필요합니다 (`npm-missing`) | Node.js는 있지만 npm이 PATH에 없습니다. | npm이 포함된 Node.js를 설치합니다(위 명령 사용). |
| 이 서버에서는 Mixdog을 실행할 수 없습니다 (`unsupported-platform`) | Windows 서버, Linux/macOS가 아닌 시스템, x64/arm64가 아닌 CPU, Alpine 같은 musl 리눅스입니다. | 지원되는 서버(glibc 기반 Linux, macOS)를 사용합니다. |
| 설치하지 못했습니다 (`install-failed`) | 업로드한 파일이 손상되었거나 잠금 파일·권한 문제 등으로 설치 단계가 실패했습니다. 상세 내용에 이유가 있습니다. | 홈 폴더의 쓰기 권한과 디스크 여유 공간을 확인한 뒤 다시 시도합니다. 계속되면 [서버에서 Mixdog 지우기](#서버에서-mixdog-지우기) 후 다시 연결합니다. |
| 서버에서 Mixdog에 필요한 구성 요소를 설치하지 못했습니다 (`deps-install`) | 서버의 `npm`이 npm 레지스트리나 github.com에 접속하지 못했습니다. | 서버의 인터넷, 프록시, `npm config`를 확인합니다. 다음 연결 때 설치를 다시 시도합니다. |
| 다른 설치가 진행 중입니다 (`install-locked`) | 다른 PC나 다른 창이 같은 서버에 설치하는 중입니다. | 잠시 기다린 뒤 다시 시도합니다. 설치가 중단되어 남은 오래된 잠금은 자동으로 정리됩니다. |
| 서버에 사용할 수 있는 포트가 없습니다 (`port-unavailable`) | 서버에서 Mixdog이 쓸 루프백 포트를 열지 못했습니다. | 서버의 방화벽·프로세스를 확인하고 사용 중인 포트를 정리합니다. |
| 서버의 Mixdog을 다시 시작할까요? (`daemon-busy-other-version`) | 서버에서 **다른 버전**의 Mixdog이 작업 중이거나 다른 PC가 연결되어 있습니다. 앱 업데이트 직후의 이전 연결은 약 35초 기다린 뒤 이 안내로 바뀝니다. | 작업이 끝나길 기다리거나 **다시 시작하고 연결**을 누릅니다. 실행 중인 작업이 중단되고 다른 PC의 연결이 끊어집니다. |
| 서버의 Mixdog을 종료할까요? (`daemon-not-proxy`) | 서버에 따로 실행 중인 Mixdog(프로세스 번호 표시)이 있고, 내 PC로 모델을 보내는 모드가 아닙니다. 그대로 붙으면 서버의 계정으로 모델이 실행되기 때문에 연결하지 않습니다. | 문제없으면 **종료하고 연결**을 누르거나, 서버에서 해당 프로세스를 직접 종료(`kill <번호>`)한 뒤 다시 연결합니다. |
| 서버의 Mixdog이 다른 방식으로 실행 중입니다 (`daemon-unmanaged`) | 이 앱이 시작하지 않은 Mixdog이 이 앱의 접속 정보를 쓰고 있습니다. 앱은 그런 프로세스를 끄지 않습니다. | 서버에서 그 Mixdog을 직접 종료하거나 그쪽을 직접 사용한 뒤 다시 연결합니다. |
| 서버의 Mixdog 데이터가 사용 중입니다 (`daemon-data-in-use`) | 다른 Mixdog이 같은 서버 데이터 폴더(`~/.mixdog-remote/user-data`)를 쓰고 있습니다. | 서버에서 그 Mixdog을 종료한 뒤 다시 연결합니다. |
| 이전 Mixdog을 종료하지 못했습니다 (`daemon-stop`) | 서버의 이전 Mixdog이 종료 신호에도 끝나지 않았습니다. | 서버에서 상세 내용의 프로세스를 직접 종료(`kill -9`)하고 다시 시도합니다. |
| Mixdog을 교체하지 못했습니다 (`daemon-replace`) | 다른 Mixdog이 계속 세션 포트를 다시 차지합니다. | 서버에서 실행 중인 Mixdog과 자동 재시작 설정(서비스, 스크립트)을 확인합니다. |
| 이 Mixdog을 확인할 수 없습니다 (`daemon-unproven`) | 정리 중에 접속 정보를 잡고 있는 프로세스가 Mixdog인지 확인되지 않아 아무것도 지우지 않았습니다. | 서버에서 해당 프로세스를 확인해 종료한 뒤 다시 시도합니다. |
| 서버의 Mixdog 버전이 맞지 않습니다 (`protocol-mismatch`) | 서버의 Mixdog이 이 앱과 호환되지 않는 통신 규약입니다. | 다시 연결하면 이 앱과 같은 버전을 서버에 설치합니다. 계속되면 설정 → 연결의 "서버에서 Mixdog 정리…"로 지운 뒤 다시 연결합니다. |
| 연결하지 못했습니다 + 상세 내용 (`daemon-exited`, `daemon-timeout`, `daemon-unhealthy`) | 서버의 Mixdog이 시작 직후 종료되었거나 제때 준비되지 못했습니다. | 상세 내용의 `daemon.log` 마지막 줄이나 **서버 로그 가져오기**를 확인합니다. 메모리·디스크·Node.js 상태가 흔한 원인입니다. |
| 서버의 로그인 셸이 연결을 방해합니다 (`remote-shell`, `remote-home`) | 로그인할 때 서버가 예상 밖의 출력을 내보냈거나, 홈 폴더를 쓸 수 없습니다. | `~/.bashrc` 같은 로그인 스크립트가 비대화형 SSH에서 출력을 내지 않도록 정리하고 다시 시도합니다. |
| 예상하지 못한 오류가 발생했습니다 (`internal`, `protocol`) | 서버 쪽 설치 프로그램이 예상하지 못한 결과를 냈습니다. | **로그 보기** 또는 **진단 정보 복사**로 내용을 확인해 이슈를 올릴 때 함께 첨부합니다. |
| 연결하지 못했습니다 + "does not answer through the ssh tunnel" / "Another process answered" | SSH 터널은 열렸지만 끝에서 기대한 Mixdog이 응답하지 않거나 다른 프로세스가 응답했습니다. 보안 확인에서 멈춘 것입니다. | 다시 연결합니다. 반복되면 서버 로그와 방화벽·AllowTcpForwarding 설정을 확인합니다. |
| 연결하지 못했습니다 + 상세 내용 (`host-key-unreachable`, `ssh-transient`, `ssh-terminal`) | 지문을 읽거나 접속하지 못했습니다. 주소·포트가 틀렸거나, 서버가 꺼져 있거나, 방화벽·VPN이 막고 있습니다. | 터미널에서 `ssh user@서버`로 접속되는지 먼저 확인합니다. |
| 연결이 끊겼습니다 — "서버에 너무 오래 연결하지 못했습니다" | 자동 재시도로도 서버에 닿지 못했습니다. | 네트워크와 서버 상태를 확인한 뒤 **다시 연결**을 누릅니다. |
| 연결이 끊겼습니다 — "다시 로그인이 필요합니다" | 연결 도중 로그인이 거절되었습니다(키 변경 등). | 설정 → 연결에서 서버를 다시 연결해 로그인합니다. |
| 연결이 끊겼습니다 — "확인이 필요합니다" | 지문 변경이나 로그인 거절처럼 사람의 확인이 필요한 문제입니다. | 설정 → 연결에서 다시 연결해 안내를 따릅니다. |
| 연결이 끊겼습니다 — "자동으로 다시 연결하지 않도록 설정되어 있습니다" | 서버 설정에서 자동 재연결을 껐습니다. | **다시 연결**을 누르거나 설정을 켭니다. |

`ssh-agent`, 키 형식, 프록시 같은 SSH 자체의 문제는 터미널에서 `ssh -v user@서버`로 같은 현상을 재현하면 원인을 더 쉽게 찾을 수 있습니다.

## 서버에서 Mixdog 지우기

더는 쓰지 않는 서버에서 Mixdog을 지우려면 앱의 정리 기능을 쓰십시오.

1. 설정 → 연결의 서버 목록에서 **서버에서 Mixdog 정리…**를 선택합니다.
2. 옵션을 고릅니다.
   - **작업 기록도 삭제**: 서버의 `user-data`(설정과 작업 기록)까지 삭제합니다. 선택하지 않으면 `user-data`만 남기고 지웁니다.
   - **정리한 뒤 목록에서도 삭제**: 이 서버를 저장 목록에서도 지웁니다.
3. **정리**를 누릅니다. 서버 창이 먼저 닫히고, 그 창에서 하던 작업도 멈춥니다. 진행은 "서버 접속 → Mixdog 데몬 종료 → Mixdog 파일 삭제" 순서로 표시됩니다.

정리는 이 앱이 `~/.mixdog-remote/versions` 아래에서 실행한 Mixdog만 종료합니다(종료 요청, 응답이 없으면 SIGTERM, 그래도 안 되면 SIGKILL). 사용자가 직접 설치해 실행하는 Mixdog은 건드리지 않습니다. "종료" 단계와 "삭제" 단계는 각각 서버의 설치 잠금을 잡은 채로 진행하고, 삭제 단계는 다시 종료·확인한 뒤 같은 잠금 안에서 지우므로 그사이에 다른 창이 설치하거나 데몬을 띄울 수 없습니다. `~/.mixdog-remote`가 이미 없으면 지울 것이 없다고 보고 끝납니다. 다음 경우에는 아무것도 지우지 않고 이유를 알려 줍니다.

- Mixdog인지 확인할 수 없는 프로세스가 접속 정보를 잡고 있을 때
- 종료한 뒤에도 `~/.mixdog-remote`의 Mixdog 코드를 실행하거나 그 데이터 폴더를 쓰는 프로세스가 남아 있을 때
- 서버에 Node.js가 없거나 너무 오래되었을 때: 어떤 데몬을 멈춰도 되는지 확인할 수 없으므로 정리하지 않습니다. Node.js 22 이상을 설치한 뒤 다시 시도하거나 아래처럼 직접 지우십시오.

**직접 지우기** (서버에 SSH로 접속할 수 있을 때)

```bash
# 1) 실행 중인 Mixdog 확인 후 종료
cat ~/.mixdog-remote/runtime/daemon.json    # "pid" 확인
kill <pid>                                  # 응답이 없으면 kill -9 <pid>

# 2) 파일 삭제 (작업 기록을 남기려면 user-data는 빼고 지웁니다)
rm -rf ~/.mixdog-remote

# 3) 선택: npm이 만든 다운로드 캐시
rm -rf ~/.npm
```

`~/.npm`은 다른 npm 작업에도 쓰이므로 필요 없을 때만 지우십시오. 앱에서 서버를 지운 뒤에는 이 PC의 Mixdog 전용 `known_hosts`(앱 데이터 폴더의 `ssh/known_hosts`)에 서버의 지문이 남아 있는데, 해당 줄은 그대로 두어도 문제가 없습니다.

---

## English summary

**What it is.** Open a remote server from a Mixdog desktop window over SSH. Files, editor, terminal and Git run on the server; AI model calls run on *this* PC with this PC's sign-in, so no API keys are stored on the server. This differs from "Open another PC" (Settings → Connection), which pairs with another PC that runs the Mixdog desktop app by code.

**Requirements.** Server: Linux (x64/arm64, glibc) or macOS, Node.js 22+ with npm, npm registry and github.com access, sshd; no root. This PC: the OpenSSH client.

**Connect.** Settings → Connection → *Connect SSH server*, enter `user@host[:port]` or an `~/.ssh/config` alias. On first contact Mixdog shows the server's fingerprint and pins it in its own `known_hosts` only after you confirm; a changed key blocks the connection. Login uses your keys/ssh-agent first; a refused login falls back to prompts for a key passphrase, a password or an OTP code (never stored). ProxyJump hops are confirmed one at a time.

**On the server.** Everything lives in `~/.mixdog-remote` (`versions/`, `deps/`, `runtime/`, `user-data/`, `daemon.log`); no services, no root. npm may keep its own cache in `~/.npm`.

**Security.** The server-side daemon listens on `127.0.0.1` only and needs a token; the desktop reaches it through an `ssh -L` tunnel and verifies the process behind it first. It only attaches to a daemon in client model-proxy mode, so models always use this PC's sign-in, and each server can be limited to chosen providers. Agent and X11 forwarding are forced off, host keys are checked strictly, and Mixdog uses its own `known_hosts`. The agent runs commands with the permissions of the account you log in with.

**Server window.** Files and the terminal are the server's; attachments are uploaded to the server; previews and downloads read from the server. Features that act on this PC (Computer Use, browser pane, phone access, desktop updates, opening this PC's folders or handing server files to this PC's apps) are unavailable there. The *Ports* panel (left rail → *More* → *Ports*) lists what listens on the server (refreshed every 5 s while visible, with process names; Mixdog's own ports hidden). *Forward* maps a server port to the same port on this PC when it is free and ≥ 1024, otherwise any free port, bound to `127.0.0.1` only; new ports are only suggested (*Forward* / *Ignore*), never forwarded automatically. Forwards can be opened in the browser, stopped, and are saved per server and restored on reconnect or relaunch. Limits: key-file/agent login only (password/OTP-only servers cannot forward), and services bound only to `::1` will not answer.

**Disconnects.** The window reconnects automatically (1 s up to 30 s steps); server work continues during the grace time (default 30 min, 1 min–7 days per server). Problems that need a person (changed host key, refused login, server setup) stop the retries until you reconnect from Settings → Connection.

**Diagnostics.** *View log*, *Copy diagnostics* and *Fetch server log* (last 200 lines of `~/.mixdog-remote/daemon.log`). Secret-looking values (tokens, passwords) are removed everywhere, but the text shown in the dialog still contains the server address and user name; only the copied text replaces them with `<server>` (short names only as `user@host`). Review before sharing.

**Reconnect banner.** While reconnecting it shows the attempt and a countdown with *Reconnect now* (runs the waiting attempt immediately; backoff and the grace clock continue unchanged). *Reconnect* and *Close window* appear only once reconnecting has stopped ("Connection to … lost"). Background connections always use `BatchMode`; only a user-initiated retry after a refused login may prompt (askpass).

**Model-call safeguards.** While the SSH connection is open, the server's model calls run on this PC like local use: there is no grant, time limit, call or token budget, rate limit, concurrency cap or per-call time cap. Each call is limited in size (128 MiB) and a server may hold at most 256 MiB of call data at once. Calls are cancelled when the connection closes, and a call whose server stops answering for 20 seconds is abandoned. Only the providers allowed for that server can be used, and attachments stored on this PC are not readable by the server.

**Housekeeping.** `daemon.log` over 5 MB is copied to `daemon.log.1` and truncated. Old `versions/` folders are removed keeping the current and previous version and any version a live process uses; nothing is removed if the process list cannot be read.

**Troubleshooting.** See the table in [문제 해결](#문제-해결); each row names the error code (for example `node-too-old`, `npm-missing`, `unsupported-platform`, `deps-install`, `install-locked`, `daemon-busy-other-version`, `daemon-not-proxy`, `host-key-changed`, `auth`).

**Removing Mixdog.** Use *Clean up Mixdog on the server…* (stops the daemon Mixdog started, removes `~/.mixdog-remote`, optionally keeps or deletes `user-data` and the list entry), or by hand: `kill <pid from ~/.mixdog-remote/runtime/daemon.json>; rm -rf ~/.mixdog-remote`.

**Automated test.** `npm run test:ssh:e2e --prefix apps/desktop` builds a throwaway Docker server and exercises pinning, install, attach, terminal, tunnel reconnect, daemon reuse and cleanup; it skips when Docker is unavailable.
