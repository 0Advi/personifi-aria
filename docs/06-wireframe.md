# Wireframe / Mock Diagram

## Conversational Interface Flow

Aria operates as a **chat-native agent** — no separate app or dashboard required. The wireframe below shows the Telegram interface flow.

```mermaid
graph TD
    subgraph S1["Screen 1 - First Contact"]
        S1A["🤖 Aria: Hey! I'm Aria, your\nlocal travel guide 🌍\nWhat should I call you?"]
        S1B["👤 User: Aditya"]
        S1C["🤖 Aria: Nice to meet you,\nAditya! Share your location\nso I can find spots near you"]
        S1D["📍 Share Location Button"]
    end

    subgraph S2["Screen 2 - Stimulus Trigger"]
        S2A["🤖 Aria: It's raining in\nHyderabad right now ☔\nPerfect weather for chai!\nWant me to find a cozy\ncafe nearby?"]
        S2B["📱 Yes, find me one\nNo thanks\nShow indoor activities"]
    end

    subgraph S3["Screen 3 - Tool Execution"]
        S3A["🤖 Aria: Found 3 great\nspots near Banjara Hills!"]
        S3B["📍 Cafe Niloufer - ⭐ 4.5\n📍 Roastery Coffee - ⭐ 4.3\n📍 Autumn Leaf Cafe - ⭐ 4.6"]
        S3C["📸 Venue Photo"]
        S3D["🤖 Want directions to any\nof these? Or compare\ndelivery prices?"]
    end

    subgraph S4["Screen 4 - Price Comparison"]
        S4A["👤 User: Compare food delivery\nprices for biryani near me"]
        S4B["🤖 Aria: Comparing across\nSwiggy and Zomato..."]
        S4C["📊 Paradise Biryani\nSwiggy: ₹299 + ₹30 delivery\nZomato: ₹285 + ₹25 delivery\n💡 Zomato is ₹19 cheaper!"]
    end

    S1D --> S2A
    S2B --> S3A
    S3D --> S4A
```

## System Component Wireframe

```mermaid
graph TB
    subgraph FE["Frontend - Chat Interface"]
        UI1[Message Input]
        UI2[Location Share Button]
        UI3[Inline Action Buttons]
        UI4["Photo / Media Display"]
        UI5["Map Pin / Venue Cards"]
    end

    subgraph BK["Backend - Aria Core"]
        BE1[Fastify Webhook Server]
        BE2[Channel Adapter Layer]
        BE3[Handler Pipeline]
        BE4[Tool Executor]
        BE5[Response Composer]
    end

    subgraph DL["Data Layer"]
        DL1["PostgreSQL\nSessions, Memory, Preferences"]
        DL2["DynamoDB\nEngagement Metrics"]
        DL3["S3\nTraining Archives"]
    end

    UI1 --> BE1
    UI2 --> BE1
    BE1 --> BE2 --> BE3
    BE3 --> BE4
    BE3 --> BE5
    BE5 --> UI3
    BE5 --> UI4
    BE5 --> UI5

    BE3 --> DL1
    BE4 --> DL2
    BE4 --> DL3
```
