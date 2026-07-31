<script setup lang="ts">
import { useHomeCopy } from "../i18n"

const t = useHomeCopy()
</script>

<template>
  <div class="session" role="img" :aria-label="t.sessionAriaLabel">
    <div class="session__chrome">
      <span class="session__brand">YADAW</span>
      <span class="session__project">night-drive.yadaw</span>
      <span class="session__status">48 kHz</span>
    </div>

    <div class="session__transport">
      <span class="session__control">■</span>
      <span class="session__control session__control--play">▶</span>
      <span class="session__control session__control--record">●</span>
      <strong class="session__time">01:12:08</strong>
      <span class="session__tempo">120.00 BPM</span>
    </div>

    <div class="session__timeline">
      <div class="session__ruler">
        <span>17</span>
        <span>21</span>
        <span>25</span>
        <span>29</span>
      </div>

      <div class="session__track">
        <div class="session__track-name"><i class="session__dot session__dot--audio" /> VOX</div>
        <div class="session__lane">
          <span class="session__clip session__clip--audio session__clip--one" />
          <span class="session__clip session__clip--audio session__clip--two" />
        </div>
      </div>

      <div class="session__track">
        <div class="session__track-name"><i class="session__dot session__dot--midi" /> SYNTH</div>
        <div class="session__lane">
          <span class="session__clip session__clip--midi session__clip--three" />
        </div>
      </div>

      <div class="session__track">
        <div class="session__track-name"><i class="session__dot session__dot--audio" /> GUITAR</div>
        <div class="session__lane">
          <span class="session__clip session__clip--audio session__clip--four" />
        </div>
      </div>

      <div class="session__playhead" />
    </div>

    <div class="session__mixer">
      <span v-for="channel in 7" :key="channel" class="session__meter">
        <i :style="{ height: `${18 + channel * 8}%` }" />
      </span>
      <span class="session__master">MASTER</span>
    </div>
  </div>
</template>

<style scoped>
.session {
  position: relative;
  width: 100%;
  border: 1px solid #3a3a3a;
  border-radius: 12px;
  color: #b8b8b8;
  background: #101010;
  box-shadow:
    0 32px 90px rgb(0 0 0 / 48%),
    0 1px 0 rgb(255 255 255 / 5%) inset;
  font-family: "SFMono-Regular", "Cascadia Code", Consolas, monospace;
  overflow: hidden;
}

.session__chrome,
.session__transport {
  display: grid;
  align-items: center;
  min-height: 34px;
  padding: 0 12px;
  border-bottom: 1px solid #343434;
  background: #1b1b1b;
  font-size: 10px;
  letter-spacing: 0.08em;
}

.session__chrome {
  grid-template-columns: 1fr auto 1fr;
}

.session__brand {
  color: #8da8b5;
  font-weight: 700;
  letter-spacing: 0.18em;
}

.session__project {
  color: #8c8c8c;
}

.session__status {
  justify-self: end;
  color: #686868;
}

.session__transport {
  grid-template-columns: repeat(3, 23px) 1fr auto;
  gap: 4px;
  min-height: 45px;
  background: #181818;
}

.session__control {
  display: grid;
  width: 23px;
  height: 23px;
  place-items: center;
  border: 1px solid #3a3a3a;
  border-radius: 5px;
  color: #686868;
  background: #292929;
  font-size: 8px;
}

.session__control--play {
  color: #72c3c7;
}

.session__control--record {
  color: #ff6577;
}

.session__time {
  justify-self: center;
  color: #e8e8e8;
  font-size: 14px;
  letter-spacing: 0.04em;
}

.session__tempo {
  color: #8da8b5;
}

.session__timeline {
  position: relative;
  background: repeating-linear-gradient(90deg, transparent 0 11.9%, #292929 12% 12.2%), #101010;
}

.session__ruler {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  height: 24px;
  padding-left: 104px;
  border-bottom: 1px solid #292929;
  color: #686868;
  background: #191919;
  font-size: 9px;
}

.session__ruler span {
  padding: 6px 0 0 5px;
  border-left: 1px solid #292929;
}

.session__track {
  display: grid;
  grid-template-columns: 104px 1fr;
  min-height: 54px;
  border-bottom: 1px solid #292929;
}

.session__track-name {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 0 10px;
  border-right: 1px solid #3a3a3a;
  background: #1c1c1c;
  font-size: 9px;
  letter-spacing: 0.1em;
}

.session__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}

.session__dot--audio {
  background: #72c3c7;
}

.session__dot--midi {
  background: #a98ade;
}

.session__lane {
  position: relative;
  min-width: 0;
}

.session__clip {
  position: absolute;
  top: 8px;
  height: 38px;
  border: 1px solid;
  border-radius: 4px;
  overflow: hidden;
}

.session__clip::after {
  position: absolute;
  inset: 7px 5px;
  content: "";
  opacity: 0.68;
}

.session__clip--audio {
  border-color: #397a7d;
  background: #173d3f;
}

.session__clip--audio::after {
  background:
    linear-gradient(
      90deg,
      transparent 0 3%,
      #72c3c7 3% 4%,
      transparent 4% 8%,
      #72c3c7 8% 10%,
      transparent 10% 16%
    ),
    linear-gradient(180deg, transparent 46%, #72c3c7 47% 53%, transparent 54%);
}

.session__clip--midi {
  border-color: #735ca1;
  background: #302447;
}

.session__clip--midi::after {
  background: repeating-linear-gradient(90deg, #a98ade 0 9%, transparent 9% 14%);
  clip-path: polygon(
    0 15%,
    20% 15%,
    20% 44%,
    43% 44%,
    43% 8%,
    68% 8%,
    68% 65%,
    100% 65%,
    100% 82%,
    0 82%
  );
}

.session__clip--one {
  left: 3%;
  width: 28%;
}

.session__clip--two {
  left: 36%;
  width: 40%;
}

.session__clip--three {
  left: 9%;
  width: 64%;
}

.session__clip--four {
  left: 23%;
  width: 55%;
}

.session__playhead {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 58%;
  width: 1px;
  background: #ff6577;
  box-shadow: 0 0 7px rgb(255 101 119 / 55%);
}

.session__playhead::before {
  position: absolute;
  top: 0;
  left: -3px;
  width: 7px;
  height: 6px;
  border-radius: 0 0 4px 4px;
  background: #ff6577;
  content: "";
}

.session__mixer {
  display: flex;
  align-items: end;
  height: 58px;
  gap: 5px;
  padding: 9px 12px;
  background: #181818;
}

.session__meter {
  position: relative;
  width: 7px;
  height: 100%;
  border-radius: 2px;
  background: #0b0b0b;
  overflow: hidden;
}

.session__meter i {
  position: absolute;
  right: 1px;
  bottom: 1px;
  left: 1px;
  border-radius: 1px;
  background: linear-gradient(0deg, #50b86d 72%, #e4b93f 72% 90%, #e54b58 90%);
}

.session__master {
  align-self: center;
  margin-left: auto;
  color: #686868;
  font-size: 8px;
  letter-spacing: 0.12em;
}

@media (max-width: 640px) {
  .session__project,
  .session__status,
  .session__tempo {
    display: none;
  }

  .session__chrome {
    grid-template-columns: 1fr;
  }

  .session__transport {
    grid-template-columns: repeat(3, 23px) 1fr;
  }

  .session__time {
    justify-self: end;
  }

  .session__track {
    grid-template-columns: 74px 1fr;
  }

  .session__track-name {
    padding: 0 7px;
    font-size: 7px;
  }

  .session__ruler {
    padding-left: 74px;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .session__playhead {
    animation: playhead-pulse 2.4s ease-in-out infinite;
  }

  @keyframes playhead-pulse {
    0%,
    100% {
      opacity: 0.7;
    }

    50% {
      opacity: 1;
    }
  }
}
</style>
