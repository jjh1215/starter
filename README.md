# starter

React(Vite) 프론트엔드 + Spring Boot 백엔드를 web/was로 분리한 프로젝트.
Nginx가 정적 파일 서빙 + `/api/*` 리버스 프록시를 담당한다.

```
브라우저 → Nginx :11000 → 정적 파일(React dist)
                        → /api/* → Spring Boot :11001 (proxy_pass)
```

| 구성 요소 | 기술 | 포트 |
|---|---|---|
| Web | React + Vite, Nginx | 11000 |
| WAS | Spring Boot (Java 21, Maven) | 11001 |

## 디렉토리 구조

```
backend/    Spring Boot (com.example.demo)
frontend/   React + Vite
deploy/     systemd --user 서비스 파일, nginx 설정 원본
.github/workflows/deploy.yml   self-hosted runner CI/CD
```

## 로컬 개발

### 백엔드

```bash
source ~/.sdkman/bin/sdkman-init.sh
cd backend
mvn spring-boot:run
# http://localhost:11001/api/hello
```

### 프론트엔드

```bash
cd frontend
npm install
npm run dev
# http://localhost:11000, /api는 vite.config.js 프록시로 11001에 전달됨
```

### 빌드

```bash
cd backend && mvn -B -DskipTests package   # backend/target/app.jar
cd frontend && npm run build                # frontend/dist
```

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/hello` | 인사 메시지 반환 |
| GET | `/api/health` | 헬스체크 (`{"status":"UP"}`) |

## 배포

`main` 브랜치에 push하면 GitHub Actions self-hosted runner가 자동으로 빌드/배포한다
(외부 노출 없이 이 서버 자체가 러너로 동작). 자세한 인프라 구축 과정과 트러블슈팅 이력은
[`DEPLOYMENT.md`](./DEPLOYMENT.md) 참고. Claude Code가 이 저장소에서 작업할 때 참고하는
요약 컨텍스트는 [`CLAUDE.md`](./CLAUDE.md)에 있다.
