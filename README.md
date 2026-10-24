# maxxing-dashboard

Personal optimization dashboard. Gym, checklist, measurements and calendar sync via the Supabase table `app_state`.

## Gym data (`maxx_gym_v1`)

The gym page stores one JSON object at `data.maxx_gym_v1` on the `app_state` row with `key = "maxxing-dashboard"`.

An external writer that adds a set or a finished workout must change only the `logs` entry or the `sessions` array it means to change, and leave every other key as it is. Do not rename ids, do not merge logs of two exercises, and do not drop fields you do not use (`slot`, `variantChoice`, `note`, `photo`, or anything unknown).

`variantChoice` may be absent. Data from before variants has no `slot` and no `variantChoice`. That is valid. Loading the page does not rewrite logs.

### Top level

```json
{
  "days": [{ "id": "chest", "name": "Chest + Triceps" }],
  "exercises": [],
  "logs": {},
  "sessions": [],
  "session": null,
  "filterDay": "chest",
  "currentEx": "ex_1710000000000_1",
  "variantChoice": { "sl_ex_1710000000000_1": "ex_1710000000000_2" }
}
```

| Field | Meaning |
| --- | --- |
| `days` | `{ "id", "name" }`. `exercises[].day` stores the id. |
| `exercises` | One object per exercise, including each variant. |
| `logs` | Map of `exerciseId` → array of sets, oldest first. |
| `session` | Workout in progress, or `null`. `{ "startedAt": <ms>, "setCount": <n> }`. `startedAt` is epoch milliseconds. |
| `sessions` | Finished workouts, oldest first. |
| `filterDay` | `days[].id` of the day on screen. |
| `currentEx` | Exercise id on screen. For a variant this is that variant's id, never the slot string. |
| `variantChoice` | Optional. Map of `slot` → exercise id last chosen for that slot. |

### `exercises[]`

Every exercise, including a variant, is a normal object with its own `id`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Stable string. Never reuse or change it. `logs` is keyed by this id. |
| `name` | yes | Name shown in the UI. |
| `day` | yes | `days[].id` this exercise belongs to. |
| `repMin`, `repMax` | yes | Target rep range, integers. |
| `step` | yes | Kilograms the progression adds. `1` for bodyweight. |
| `startWeight` | yes | Starting weight in kg. `0` for bodyweight or when left empty. |
| `bw` | no | `true` means reps only, no weight. |
| `note` | no | Free text. |
| `photo` | no | Image data-URL. |
| `slot` | no | Groups variants. Same string on the same `day` = one station in the workout. |

An exercise **without** `slot` is its own station. Leave it unchanged when you only append a set.

### Variants (A / B / …)

A variant is a normal exercise. Variants of one station share `slot` and `day`. The letter is not stored. Within that day, in `exercises` array order, the first member is A, the second is B, and so on.

Each variant has its own `id`, so it has its own `logs[id]`, its own weight and its own progression. Never copy or move logs from A to B.

`variantChoice[slot]` is the exercise id the UI opens next time that station is shown. If the key is missing, or the id is not in the group, the UI opens the first member (A).

The app writes new slot ids as `"sl_" + originalExerciseId`. Any other unique string is fine. Do not reuse one slot id on two different days. Every member of a slot stays on the same day.

A slot with one exercise behaves like an exercise without variants. The `slot` field may stay.

```json
"exercises": [
  {
    "id": "ex_a",
    "name": "Upper Incline Cable Chest",
    "day": "chest",
    "repMin": 10,
    "repMax": 15,
    "step": 2.5,
    "startWeight": 20,
    "slot": "sl_ex_a"
  },
  {
    "id": "ex_b",
    "name": "Incline Dumbbell Press",
    "day": "chest",
    "repMin": 8,
    "repMax": 12,
    "step": 2,
    "startWeight": 22,
    "slot": "sl_ex_a"
  }
],
"variantChoice": { "sl_ex_a": "ex_b" }
```

With that choice, the next workout opens this station on Incline Dumbbell Press. Sets logged there go to `logs.ex_b` only.

### `logs`

Key = `exercises[].id`. Value = array of sets, oldest first. Replace only the array you are appending to.

```json
"logs": {
  "ex_a": [
    { "weight": 20, "reps": 12, "rpe": 8, "date": "2026-10-24T18:04:11.000Z" }
  ],
  "ex_b": [
    { "weight": 22, "reps": 10, "rpe": 9, "date": "2026-10-24T18:11:02.000Z" }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `weight` | Number, kilograms. `0` for bodyweight. |
| `reps` | Integer > 0. |
| `rpe` | Integer, typically 6–10, or `null` when empty. |
| `date` | ISO-8601 timestamp. |

To add a set: append one object to `logs[exerciseId]` of the variant you mean. If that key does not exist yet, create an array with just that set. Leave every other key in `logs` in place.

The page does not delete or rewrite logs when it opens. Removing a variant in the UI deletes that one exercise and `logs` under that id only. Other variants and their logs stay.

### `sessions`

Append finished workouts. Do not replace the array.

```json
{
  "date": "2026-10-24T19:00:00.000Z",
  "startedAt": 1729782000000,
  "endedAt": 1729785600000,
  "durationMin": 60,
  "sets": 18,
  "dayId": "chest",
  "dayName": "Chest + Triceps"
}
```

`date`, `startedAt` and `endedAt` are how the app writes them: `date` is an ISO timestamp, `startedAt` and `endedAt` are epoch milliseconds. Older rows may omit `dayId` and `dayName`. Keep any extra fields already on a session.
