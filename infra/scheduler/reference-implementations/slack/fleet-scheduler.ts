export interface FleetScheduler {
  getStatus?: () => unknown;
  getStatusSnapshot?: () => any;
}
