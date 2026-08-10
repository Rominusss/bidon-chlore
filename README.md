# Chlorinator Tank Card

Home Assistant Lovelace card for a 20 L dosing tank using a cumulative injected-volume sensor.

## HACS

Add this GitHub repository to HACS as a **Dashboard** custom repository, then install it.

## Required helper

Create:

```yaml
input_number:
  chlorinator_bidon_depart:
    name: Chlorinator - volume total au remplissage
    min: 0
    max: 999999
    step: 0.001
    mode: box
    unit_of_measurement: "L"
```

## Card configuration

```yaml
type: custom:chlorinator-tank-card
name: Bidon de chlore
tank_capacity: 20
volume_total_entity: sensor.chlorinator_volume_injecte_total
volume_today_entity: sensor.chlorinator_volume_injecte_aujourdhui
volume_yesterday_entity: sensor.chlorinator_volume_injecte_hier
refill_baseline_entity: input_number.chlorinator_bidon_depart
low_threshold: 25
critical_threshold: 10
empty_threshold: 5
```

Click **Bidon rempli** after filling the tank. The card stores the current cumulative volume as the new baseline.

Remaining volume = tank capacity - (current cumulative volume - refill baseline).
