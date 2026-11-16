// Embodied carbon (A1-A3) of the shell concrete.
//
// Factor: ShellBench v1.0.0, data/carbon_factors.csv, row GBT51366,C40:
// 340 kgCO2e/m3, the linear interpolation of C30 (295) and C50 (385) in
// GB/T 51366-2019 Appendix D, Table D.0.1. The +/-25 % band is the one
// ShellForm applies to its carbon results (carbon.py, FACTOR_BAND).
export const CONCRETE = {
  grade: 'C40',
  factor: 340, // kgCO2e per m3
  source: 'GB/T 51366-2019 Table D.0.1 via ShellBench v1.0.0',
};
export const BAND = 0.25;

/** A1-A3 carbon of a concrete volume [m3], as { mid, lo, hi } in kgCO2e. */
export function carbon(volumeM3) {
  const mid = volumeM3 * CONCRETE.factor;
  return { mid, lo: mid * (1 - BAND), hi: mid * (1 + BAND) };
}
