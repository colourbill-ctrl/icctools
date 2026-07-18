// (c) 2026 William Li
/**
 * roundtrip-eval.hpp — CIccMinMaxEval, the round-trip ΔE accumulator.
 *
 * A header-only, verbatim port of the accumulator currently trapped inside the
 * CLI tool `Tools/CmdLine/IccRoundTrip/iccRoundTrip.cpp` (class body at :83-150).
 * Lifting it here keeps the WASM `roundTrip` wrapper a thin caller and lets the
 * class migrate into IccProfLib (beside CIccEvalCompare/in IccEval) unchanged —
 * that promotion is the Group-A upstream contribution.
 *
 * It subclasses CIccEvalCompare and implements Compare(): CIccEvalCompare walks
 * the device cube, and for every seed it hands us the device colour's Lab
 * (deviceLab), the once-round-tripped Lab (lab1 = device→PCS→device→PCS), and
 * the twice-round-tripped Lab (lab2). We accumulate two CIE76 ΔE distributions:
 *   Round Trip 1 = ΔE(deviceLab, lab1),  Round Trip 2 = ΔE(lab1, lab2).
 * No filesystem, no IccProfLib changes — EvaluateProfile(CIccProfile*, …) exists.
 */
#ifndef PROFILETOOL_ROUNDTRIP_EVAL_HPP
#define PROFILETOOL_ROUNDTRIP_EVAL_HPP

#include <cstring>
#include "IccEval.h"
#include "IccUtil.h"

class CIccMinMaxEval : public CIccEvalCompare
{
public:
  CIccMinMaxEval()
  {
    minDE1 = minDE2 = 10000;
    maxDE1 = maxDE2 = -1;
    sum1 = sum2 = 0;
    num1 = num2 = 0.0;
    num3 = m_nTotal = 0;

    memset(&maxLab1[0], 0, sizeof(maxLab1));
    memset(&maxLab2[0], 0, sizeof(maxLab2));
  }

  void Compare(icFloatNumber * /*pixel*/, icFloatNumber *deviceLab,
               icFloatNumber *lab1, icFloatNumber *lab2) override
  {
    icFloatNumber DE1 = icDeltaE(deviceLab, lab1);
    icFloatNumber DE2 = icDeltaE(lab1, lab2);

    if (DE1 < minDE1) {
      minDE1 = DE1;
    }

    if (DE1 > maxDE1) {
      maxDE1 = DE1;
      memcpy(&maxLab1[0], deviceLab, sizeof(maxLab1));
    }

    if (DE2 < minDE2) {
      minDE2 = DE2;
    }

    if (DE2 > maxDE2) {
      maxDE2 = DE2;
      memcpy(&maxLab2[0], deviceLab, sizeof(maxLab2));
    }

    if (DE2 <= 1.0)
      num3 += 1;

    sum1 += DE1;
    num1 += 1.0;

    sum2 += DE2;
    num2 += 1.0;

    m_nTotal += 1;
  }

  icFloatNumber GetMean1() { if (num1 == 0.0) return 0.0; return sum1 / num1; }
  icFloatNumber GetMean2() { if (num2 == 0.0) return 0.0; else return sum2 / num2; }

  icFloatNumber minDE1, minDE2;
  icFloatNumber maxDE1, maxDE2;
  icUInt32Number num3, m_nTotal;

  icFloatNumber maxLab1[3], maxLab2[3];

protected:

  icFloatNumber sum1, sum2;
  icFloatNumber num1, num2;
};

#endif // PROFILETOOL_ROUNDTRIP_EVAL_HPP
