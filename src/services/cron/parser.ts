export function isValidCron(pattern: string): boolean {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges: [number, number][] = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ];

  for (let i = 0; i < 5; i++) {
    const part = parts[i];
    if (part === undefined) return false;
    const range = ranges[i];
    if (!range) return false;
    const [min, max] = range;
    if (!validateField(part, min, max)) return false;
  }

  return true;
}

function validateField(field: string, min: number, max: number): boolean {
  const segments = field.split(",");

  for (const seg of segments) {
    if (seg === "*") continue;

    const stepMatch = seg.match(/^(.+?)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      if (!step || step < 1) return false;
      if (base === "*") continue;
      if (!base || !validateRangeOrValue(base, min, max)) return false;
      continue;
    }

    if (!validateRangeOrValue(seg, min, max)) return false;
  }

  return true;
}

function validateRangeOrValue(segment: string, min: number, max: number): boolean {
  if (segment.includes("-")) {
    const [a, b] = segment.split("-");
    const aNum = Number(a);
    const bNum = Number(b);
    if (Number.isNaN(aNum) || Number.isNaN(bNum)) return false;
    if (aNum < min || aNum > max || bNum < min || bNum > max) return false;
    if (aNum > bNum) return false;
    return true;
  }

  const n = Number(segment);
  if (Number.isNaN(n)) return false;
  return n >= min && n <= max;
}

export function getNextFireTime(pattern: string, from: Date): Date {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Invalid cron pattern: expected 5 fields");
  const minuteSet = parseField(parts[0] as string, 0, 59);
  const hourSet = parseField(parts[1] as string, 0, 23);
  const domSet = parseField(parts[2] as string, 1, 31);
  const monthSet = parseField(parts[3] as string, 1, 12);
  const dowSet = parseField(parts[4] as string, 0, 6);

  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);

  const MAX_ITERATIONS = 525_600 * 4; // 4 years in minutes

  const domIsWildcard = parts[2] === "*";
  const dowIsWildcard = parts[4] === "*";

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (!monthSet.has(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const domMatch = domSet.has(d.getDate());
    const dowMatch = dowSet.has(d.getDay());

    if (domIsWildcard && dowIsWildcard) {
      // both wildcard — any day matches
    } else if (domIsWildcard) {
      if (!dowMatch) {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
    } else if (dowIsWildcard) {
      if (!domMatch) {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
    } else {
      if (!domMatch && !dowMatch) {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
        continue;
      }
    }

    if (!hourSet.has(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!minuteSet.has(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }

    return d;
  }

  throw new Error("Could not find next fire time within 4 years");
}

function parseField(field: string, min: number, max: number): Set<number> {
  const result = new Set<number>();
  const segments = field.split(",");

  for (const seg of segments) {
    if (seg === "*") {
      for (let i = min; i <= max; i++) result.add(i);
      continue;
    }

    const stepMatch = seg.match(/^(.+?)\/(\d+)$/);
    if (stepMatch) {
      const [, base, stepStr] = stepMatch;
      const step = Number(stepStr);
      let rangeMin = min;
      let rangeMax = max;

      if (base !== "*" && base) {
        if (base.includes("-")) {
          const [a, b] = base.split("-");
          rangeMin = Number(a);
          rangeMax = Number(b);
        } else {
          rangeMin = Number(base);
        }
      }

      for (let i = rangeMin; i <= rangeMax; i += step) {
        result.add(i);
      }
      continue;
    }

    if (seg.includes("-")) {
      const [a, b] = seg.split("-");
      const aNum = Number(a);
      const bNum = Number(b);
      for (let i = aNum; i <= bNum; i++) {
        result.add(i);
      }
      continue;
    }

    result.add(Number(seg));
  }

  return result;
}
