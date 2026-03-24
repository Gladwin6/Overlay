/**
 * Simple 1D Kalman Filter for smoothing CV tracking output.
 * One instance per axis (rotX, rotY, panX, panY, scale).
 */
export class KalmanFilter1D {
  private x: number;          // state estimate
  private v: number;          // velocity estimate
  private p: number;          // estimate covariance
  private q: number;          // process noise
  private r: number;          // measurement noise

  constructor(processNoise: number = 0.1, measurementNoise: number = 1.0) {
    this.x = 0;
    this.v = 0;
    this.p = 1;
    this.q = processNoise;
    this.r = measurementNoise;
  }

  /**
   * Predict step: advance state by dt using velocity estimate.
   */
  predict(dt: number): number {
    this.x += this.v * dt;
    this.p += this.q;
    return this.x;
  }

  /**
   * Update step: incorporate a new measurement.
   * Returns the filtered value.
   */
  update(measurement: number): number {
    // Kalman gain
    const k = this.p / (this.p + this.r);

    // Update velocity estimate from innovation
    const innovation = measurement - this.x;
    this.v = 0.8 * this.v + 0.2 * innovation; // exponential smoothing on velocity

    // Update state
    this.x += k * innovation;
    this.p *= (1 - k);

    return this.x;
  }

  /**
   * Reset filter to a specific value.
   */
  reset(value: number = 0): void {
    this.x = value;
    this.v = 0;
    this.p = 1;
  }

  getValue(): number {
    return this.x;
  }
}
