# starter — web/was 분리 구성

React(Vite) 프론트엔드 + Spring Boot 백엔드, 계정(claude) 전용 systemd + 시스템 Nginx로 구성된 프로젝트.

## 계정/권한 제약

- 로그인 계정은 `claude`이며 **sudo 권한이 전혀 없다.**
- sudo가 필요한 명령은 절대 직접 실행하지 말 것. 실행해야 할 정확한 명령어를 코드블록으로 보여주고, 이유를 한 줄로 설명한 뒤 "sudo 권한이 있는 다른 세션에서 실행한 뒤 완료되면 알려달라"고 말하고 멈출 것. 사용자가 "완료했어/실행했어"라고 답하기 전까지 다음 단계로 넘어가지 말 것.
- Java, Maven, Node, systemd(user) 서비스, GitHub Actions runner는 전부 `claude` 계정 안에 sudo 없이 설치되어 있다.
- Nginx만 시스템 패키지(sudo dnf install)로 설치되어 있다.
- **딱 하나 예외**: `sudo /usr/sbin/nginx -s reload`는 `/etc/sudoers.d/starter-nginx`에 NOPASSWD로 등록되어 있어 claude 계정에서 비밀번호 없이 실행 가능하다 (배포 스크립트가 이걸 사용).

## 포트 / 아키텍처

```
브라우저 → Nginx :11000 → 정적 파일(React dist) 서빙
                        → /api/* 는 http://127.0.0.1:11001 (Spring Boot)로 프록시
```

- Web(Nginx): 11000
- WAS(Spring Boot): 11001
- 방화벽(firewalld): 11000/tcp 개방됨. 11001은 nginx를 통해서만 접근(외부 미개방).

## 디렉토리 구조

```
~/starter/
├── backend/            Spring Boot(Maven, Java 21) — com.example.demo
│   └── src/main/java/com/example/demo/{DemoApplication.java, controller/HelloController.java}
├── frontend/            React + Vite
│   ├── src/{App.jsx, main.jsx}, vite.config.js (dev server 11000, /api → 11001 프록시)
│   └── dist/            빌드 산출물 (nginx root, git 미추적)
├── deploy/
│   ├── starter-backend.service   systemd --user 서비스 (Spring Boot 실행)
│   ├── starter-runner.service    systemd --user 서비스 (GitHub Actions self-hosted runner)
│   └── nginx-starter.conf        /etc/nginx/conf.d/starter.conf 로 배포된 원본
├── .github/workflows/deploy.yml  main push 시 자동 빌드+배포
├── app.jar               배포된 백엔드 jar (git 미추적, deploy가 덮어씀)
└── CLAUDE.md              이 파일
```

## 로컬 실행 환경

- Java/Maven: SDKMAN (`source ~/.sdkman/bin/sdkman-init.sh`), Java 21.0.4-tem
- Node: nvm, v22.23.2 (`~/.nvm/versions/node/v22.23.2/bin`)
- `systemctl --user ...` 명령을 쓸 때는 셸에 `XDG_RUNTIME_DIR`가 비어 있을 수 있으니 먼저 `export XDG_RUNTIME_DIR=/run/user/$(id -u)`를 실행할 것.

## systemd --user 서비스

| 서비스 | 역할 | 명령 |
|---|---|---|
| `starter-backend` | Spring Boot 실행 (`~/starter/app.jar`) | `systemctl --user restart starter-backend` |
| `starter-runner` | GitHub Actions self-hosted runner | `systemctl --user status starter-runner` |

두 서비스 모두 `loginctl enable-linger claude`가 설정되어 있어 로그아웃 후에도 계속 실행된다.

## GitHub / CI-CD

- 저장소: `https://github.com/jjh1215/starter` (계정 jjh1215, `gh auth status`로 인증됨)
- **Self-hosted runner 사용** — 이 서버가 사설 IP(192.168.x.x 등)만 가지고 있어 GitHub 클라우드 러너가 SSH로 직접 접속할 수 없다. 그래서 SSH 키/공인 IP 노출 없이, 이 서버 자체가 러너로 등록되어 GitHub에 아웃바운드로만 연결된다.
- `main` push 시 `.github/workflows/deploy.yml` 실행:
  1. `build-backend` / `build-frontend` 병렬 빌드 (jar, dist를 artifact로 업로드)
  2. `deploy`: jar를 `~/starter/app.jar`로 교체 후 `systemctl --user restart starter-backend`, frontend는 `dist_new`에 새로 받아서 atomic swap으로 `dist` 교체, `restorecon -Rv ~/starter/frontend/dist`로 SELinux 라벨 복구, 마지막에 `sudo /usr/sbin/nginx -s reload`
- Actions secrets는 **사용하지 않음** (self-hosted라 불필요).

## 알아둬야 할 함정 (트러블슈팅 이력)

- **nginx 바이너리 경로**: 이 시스템은 `/usr/bin/nginx`가 아니라 **`/usr/sbin/nginx`**에 있다. sudoers/워크플로우 모두 `/usr/sbin/nginx` 기준.
- **기본 80포트 충돌**: `nginx.conf`의 기본 `server { listen 80; }` 블록이 이 호스트에서 이미 다른 프로세스가 쓰는 80포트와 충돌해서 nginx가 기동 실패했었다. 그 블록을 제거해서 해결함(백업: `/etc/nginx/nginx.conf.bak`). 앞으로 nginx.conf를 건드릴 일이 있으면 80포트 블록이 없다는 걸 전제로 할 것.
- **SELinux 컨텍스트는 `dist`에만 걸려있음**: `semanage fcontext`로 등록된 패턴은 `/home/claude/starter/frontend/dist(/.*)?` 뿐이다. 배포 스크립트가 `dist_new`를 만들었다가 `dist`로 `mv`하는 방식이라, `mv`는 원래 라벨(`user_home_t`)을 유지해버려서 그대로 두면 nginx가 403을 낸다. 그래서 swap 직후 반드시 `restorecon -Rv ~/starter/frontend/dist`를 실행해야 한다 (이건 sudo 없이 claude 계정으로 가능 — 이미 등록된 fcontext 규칙 범위 내 relabel은 일반 사용자 권한으로 됨). deploy.yml에 이미 반영되어 있다.
- **systemd --user 관련 명령은 `XDG_RUNTIME_DIR` 없이 실행하면 "Failed to connect to bus" 에러**가 난다. 항상 `export XDG_RUNTIME_DIR=/run/user/$(id -u)` 먼저 할 것.
- **`npm ci`를 쓰려면 `package-lock.json`이 git에 커밋되어 있어야 한다** (`.gitignore`에서 제외하지 말 것). `node_modules/`, `dist/`, `backend/target/`, `app.jar`는 반대로 git에서 제외되어 있다.
- runner의 systemd 서비스(`starter-runner.service`)는 비대화형 셸이라 `.bashrc`의 nvm/sdkman init이 로드되지 않는다. 그래서 서비스 파일 자체에 `Environment=PATH=...`로 java/maven/node 경로를 명시해뒀다. Node 버전을 바꾸거나 새 툴체인을 추가하면 이 PATH도 같이 업데이트해야 한다.

## 배포 확인 방법

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user status starter-backend --no-pager
curl -s http://127.0.0.1:11000/           # 프론트 200 확인
curl -s http://127.0.0.1:11000/api/hello  # 백엔드 프록시 확인
gh run list --repo jjh1215/starter --limit 5
```
