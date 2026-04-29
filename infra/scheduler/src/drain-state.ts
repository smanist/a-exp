/** Shared drain-mode flag, readable by any module without circular imports. */

let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function setDraining(value: boolean): void {
  draining = value;
}
