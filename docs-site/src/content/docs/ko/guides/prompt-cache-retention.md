---
title: 프롬프트 캐시 보존
description: 상류 문맥 캐시와 로컬 대화 보존을 구분합니다.
---

프롬프트 캐시는 상류의 prefix 계산을 재사용합니다. 대화 기록·대화 ID·로컬 응답
재생 TTL을 보존해도 상류 KV 캐시의 실제 eviction을 막지는 못합니다. OpenCodex는
모든 프로바이더에서 무기한 캐시 재사용을 보장하지 않습니다.

## Anthropic routed 요청

공통 어댑터 선택은 명시적 정책이 없는 Anthropic OAuth 요청에1시간 ephemeral
캐싱을 요청합니다. Responses 진입 경로도 포함합니다. 명시적인 `cacheRetention`
`none`·`short`·`long`이 우선하며 API-key 경로의 기본은 short입니다.
Anthropic native passthrough는 호출자의 원문을 보존하고 재작성하지 않습니다.
TTL 요청이 곧 캐시 히트의 증거는 아닙니다.

## 다른 연결 경로

공개 API의 TTL 계약을 ChatGPT/Codex native·Kiro·Antigravity·OpenCode Go/Free나
같은 모델을 서비스하는 중계 경로에 그대로 적용하지 않습니다. 해당 어댑터에
Anthropic TTL을 생성하지 않으며 지원 미확인은 캐시 비활성화를 뜻하지 않습니다.
상류가 자동으로 캐싱할 수 있습니다.

OpenAI 공개 API의 모델별 retention, Gemini 공개 API의 explicit cache 만료 갱신은
각 native 경로와 별개입니다. xAI의 affinity나 OpenRouter의 routing stickiness도
실제 prompt-cache TTL 또는 eviction 방지 보장이 아닙니다.

## Claude Code 캐시 패널 (배포 대기)

Claude → Code 화면에 **캐시 히트·TTL** 섹션이 추가됩니다. 인증된
`GET /api/claude-code/cache`가 최근 Claude Code usage에서 프롬프트·자격 증명 없이
읽기·쓰기 토큰을 표시합니다. 입력 토큰이 캐시를 포함한다고 확인된 경우만 히트 비율을
계산하며, 어댑터의 요청 TTL과 실제 관측을 구분합니다. 필드 존재 메타데이터가 없는
과거 로그는 변환 응답에0이 있어도 미보고입니다. 읽기0은 TTL 만료의 증거가 아닙니다.
상류 만료 시각이 없으므로 카운트다운은 표시하지 않습니다. 1시간 지난 관측은 오래된
관측으로 표시하며 이 신선도 기준은 캐시 TTL이 아닙니다.

## 검증

동일 계정·모델·도구·과거 prefix를 유지하고 상류의 cache-read 토큰으로 비교합니다.
캐시 쓰기와 읽기, 필드 미보고와 명시적0을 구분합니다. Kiro의 opt-in provider
진단 `cache_telemetry`는 usage/read/write 필드 존재 여부만 기록하며 프롬프트·키·
계정 정보 또는 추정한 캐시 수치를 기록하지 않습니다.

캐시 유지를 위한 주기적인 생성 호출은 활성화하지 않습니다. 짧은 출력도 입력 읽기·
reasoning·출력·quota 비용을 소비할 수 있습니다. 실제 eviction 이후에는 다시
prefill이 필요할 수 있으며, 요약으로 문맥을 줄이는 방법은 별도의 정확성 절충입니다.
