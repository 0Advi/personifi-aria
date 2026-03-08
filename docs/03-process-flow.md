# Process Flow Diagram

## Stimulus-Driven Proactive Flow

The defining feature of Aria is the **stimulus loop** — a background process that continuously monitors environmental signals and proactively engages users when relevant.

```mermaid
flowchart TD
    subgraph SS["Stimulus Sources"]
        W[OpenWeatherMap API]
        T[Google Maps Traffic API]
        F[Festival Calendar DB]
    end

    subgraph SRT["Stimulus Router"]
        SR["Stimulus Aggregator\nPer-user, ranked by priority"]
        WS["Weather Stimulus\nRain / Heatwave / Storm"]
        TS["Traffic Stimulus\nSurge / Jam / Clearance"]
        FS["Festival Stimulus\nToday / Eve / Lead-up"]
    end

    subgraph DL["Decision Layer"]
        PE["Pulse Engine\nEngagement State"]
        IE["Influence Engine\nStrategy Selector"]
        PI["Proactive Intent\nFunnel Orchestrator"]
    end

    subgraph UI["User Interaction"]
        MSG["Proactive Message\nvia Telegram / WhatsApp"]
        BTN["Inline Buttons\nAccept / Dismiss / More"]
        FU["Funnel Flow\nMulti-step guided journey"]
    end

    W --> WS
    T --> TS
    F --> FS
    WS --> SR
    TS --> SR
    FS --> SR

    SR --> PE
    PE --> IE
    IE -->|PROACTIVE state| PI
    IE -->|ENGAGED state| PI
    IE -->|PASSIVE state| X["No action - wait"]

    PI --> MSG
    MSG --> BTN
    BTN -->|Accept| FU
    BTN -->|Dismiss| Y["Record rejection\nUpdate weights"]
    FU --> Z["Tool Execution\nBook / Compare / Navigate"]
```

## Conversational Message Flow

```mermaid
flowchart LR
    A[User Message] --> B[Sanitize]
    B --> C{Injection Attack?}
    C -->|Yes| D[Log + Block]
    C -->|No| E[8B Classify]
    E --> F{Tool Needed?}
    F -->|Yes| G["Extract Args\nExecute Tool"]
    F -->|No| H["Cognitive State\nEmotion + Goal"]
    G --> I[Compose Prompt]
    H --> I
    I --> J[70B Generate]
    J --> K[Filter Output]
    K --> L[Send Reply]
    L --> M["Save to Memory\nUpdate Engagement"]
```

## Engagement State Machine

```mermaid
stateDiagram-v2
    [*] --> PASSIVE: New user / low activity

    PASSIVE --> CURIOUS: User asks a question
    CURIOUS --> ENGAGED: Tool interaction or follow-up
    ENGAGED --> PROACTIVE: Score >= 80 + sustained activity
    PROACTIVE --> ENGAGED: Score dips below 80
    ENGAGED --> CURIOUS: Session gap > 2 hours
    CURIOUS --> PASSIVE: No interaction for 24h

    PASSIVE: Score 0-24 No proactive outreach
    CURIOUS: Score 25-49 Soft nudges only
    ENGAGED: Score 50-79 Active suggestions
    PROACTIVE: Score 80-100 Full proactive mode
```
