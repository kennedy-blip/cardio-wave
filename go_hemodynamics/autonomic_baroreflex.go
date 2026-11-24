// Package go_hemodynamics implements autonomic baroreflex analytics,
// Lomb-Scargle HRV spectral density, Ewing 30:15 scoring, and
// Hughes exponential arterial pressure-stiffness modeling.
package go_hemodynamics

import (
	"math"
	"sort"
)

// HRVBandPowers holds integrated spectral power in autonomic bands.
type HRVBandPowers struct {
	VLFPower    float64 `json:"vlfPower"`
	LFPower     float64 `json:"lfPower"`
	HFPower      float64 `json:"hfPower"`
	LFHFRatio   float64 `json:"lfHfRatio"`
	TotalPower  float64 `json:"totalPower"`
	RMSSD       float64 `json:"rmssdMs"`
	SDNN        float64 `json:"sdnnMs"`
	MeanRR      float64 `json:"meanRrMs"`
	MeanHR      float64 `json:"meanHrBpm"`
	SampleCount int     `json:"sampleCount"`
}

// EwingResult holds the 30:15 orthostatic vagal ratio assessment.
type EwingResult struct {
	Ratio30_15 float64 `json:"ratio30_15"`
	RRMax30    float64 `json:"rrMax30Ms"`
	RRMin15    float64 `json:"rrMin15Ms"`
	Class      string  `json:"classification"`
	Normal     bool    `json:"normal"`
}

// POTSAssessment holds orthostatic tachycardia evaluation.
type POTSAssessment struct {
	BaselineHR     float64 `json:"baselineHrBpm"`
	UprightHR      float64 `json:"uprightHrBpm"`
	DeltaHR        float64 `json:"deltaHrBpm"`
	Sustained      bool    `json:"sustained"`
	MeetsPOTSCrit  bool    `json:"meetsPotsCriteria"`
	Classification string  `json:"classification"`
}

// ArterialStiffness holds Moens-Korteweg/Bramwell-Hill outputs.
type ArterialStiffness struct {
	PTTms              float64 `json:"pttMs"`
	PWVmPerS           float64 `json:"pwvMPerS"`
	YoungsModulusKPa   float64 `json:"youngsModulusKPa"`
	DistensibilityKPa  float64 `json:"distensibilityPerKPa"`
	VascularAgeYears   float64 `json:"vascularAgeYears"`
	StiffnessClass     string  `json:"stiffnessClass"`
}

// QCRTResult holds capillary refill exponential fit results.
type QCRTResult struct {
	TauSeconds float64 `json:"tauSeconds"`
	T90Seconds float64 `json:"t90Seconds"`
	R2         float64 `json:"r2"`
	Class      string  `json:"classification"`
}

// LombScargle computes power spectral density for unevenly sampled RR intervals.
// timesSec: beat occurrence times in seconds; values: RR intervals in ms.
func LombScargle(timesSec []float64, values []float64, freqMin, freqMax, freqStep float64) ([]float64, []float64) {
	n := len(timesSec)
	if n < 4 || len(values) != n || freqStep <= 0 || freqMax <= freqMin {
		return nil, nil
	}
	// Demean
	mean := 0.0
	for _, v := range values {
		mean += v
	}
	mean /= float64(n)
	y := make([]float64, n)
	variance := 0.0
	for i, v := range values {
		y[i] = v - mean
		variance += y[i] * y[i]
	}
	variance /= float64(n)
	if variance < 1e-12 {
		return nil, nil
	}

	freqs := make([]float64, 0, int((freqMax-freqMin)/freqStep)+1)
	powers := make([]float64, 0, cap(freqs))
	twoPi := 2.0 * math.Pi

	for f := freqMin; f <= freqMax; f += freqStep {
		omega := twoPi * f
		// tau
		var s2, c2 float64
		for i := 0; i < n; i++ {
			arg := 2.0 * omega * timesSec[i]
			s2 += math.Sin(arg)
			c2 += math.Cos(arg)
		}
		tau := math.Atan2(s2, c2) / (2.0 * omega)

		var cosSum, sinSum, cosDen, sinDen float64
		for i := 0; i < n; i++ {
			arg := omega * (timesSec[i] - tau)
			c := math.Cos(arg)
			s := math.Sin(arg)
			cosSum += y[i] * c
			sinSum += y[i] * s
			cosDen += c * c
			sinDen += s * s
		}
		if cosDen < 1e-18 || sinDen < 1e-18 {
			continue
		}
		p := 0.5 * ((cosSum*cosSum)/cosDen + (sinSum*sinSum)/sinDen) / variance
		freqs = append(freqs, f)
		powers = append(powers, p)
	}
	return freqs, powers
}

// IntegrateBandPower integrates spectral power over [fLo, fHi] using trapezoidal rule.
func IntegrateBandPower(freqs, powers []float64, fLo, fHi float64) float64 {
	if len(freqs) == 0 || len(freqs) != len(powers) {
		return 0.0
	}
	area := 0.0
	for i := 0; i < len(freqs)-1; i++ {
		f0, f1 := freqs[i], freqs[i+1]
		p0, p1 := powers[i], powers[i+1]
		// overlap with band
		lo := math.Max(f0, fLo)
		hi := math.Min(f1, fHi)
		if hi <= lo {
			continue
		}
		// linear interpolation at lo, hi
		df := f1 - f0
		if df <= 0 {
			continue
		}
		interp := func(f float64) float64 {
			t := (f - f0) / df
			return p0 + t*(p1-p0)
		}
		area += 0.5 * (interp(lo) + interp(hi)) * (hi - lo)
	}
	if area < 0 {
		return 0.0
	}
	return area
}

// ComputeHRV computes HRV metrics from RR intervals (ms).
// timesSec optional; if nil, cumulative sum of RR/1000 is used.
func ComputeHRV(rrMs []float64, timesSec []float64) HRVBandPowers {
	out := HRVBandPowers{SampleCount: len(rrMs)}
	if len(rrMs) < 4 {
		return out
	}
	// Mean RR, HR
	sum := 0.0
	for _, v := range rrMs {
		sum += v
	}
	out.MeanRR = sum / float64(len(rrMs))
	if out.MeanRR > 0 {
		out.MeanHR = 60000.0 / out.MeanRR
	}

	// SDNN
	varSq := 0.0
	for _, v := range rrMs {
		d := v - out.MeanRR
		varSq += d * d
	}
	out.SDNN = math.Sqrt(varSq / float64(len(rrMs)))

	// RMSSD
	diffSq := 0.0
	for i := 1; i < len(rrMs); i++ {
		d := rrMs[i] - rrMs[i-1]
		diffSq += d * d
	}
	out.RMSSD = math.Sqrt(diffSq / float64(len(rrMs)-1))

	// Build times if needed
	t := timesSec
	if len(t) != len(rrMs) {
		t = make([]float64, len(rrMs))
		acc := 0.0
		for i, rr := range rrMs {
			t[i] = acc
			acc += rr / 1000.0
		}
	}

	freqs, powers := LombScargle(t, rrMs, 0.003, 0.40, 0.001)
	if len(freqs) == 0 {
		return out
	}
	out.VLFPower = IntegrateBandPower(freqs, powers, 0.003, 0.04)
	out.LFPower = IntegrateBandPower(freqs, powers, 0.04, 0.15)
	out.HFPower = IntegrateBandPower(freqs, powers, 0.15, 0.40)
	out.TotalPower = out.VLFPower + out.LFPower + out.HFPower
	if out.HFPower > 1e-12 {
		out.LFHFRatio = out.LFPower / out.HFPower
	} else {
		out.LFHFRatio = 0.0
	}
	return out
}

// EvaluateEwing30_15 computes the 30:15 ratio from RR intervals (ms) after standing.
// rrIntervals are sequential RR intervals starting at stand time.
func EvaluateEwing30_15(rrIntervals []float64) EwingResult {
	res := EwingResult{Class: "Insufficient data"}
	n := len(rrIntervals)
	if n < 20 {
		return res
	}
	// RR max around beat 30 (index 25..35, clamped)
	lo30 := 25
	hi30 := 35
	if hi30 >= n {
		hi30 = n - 1
	}
	if lo30 >= n {
		lo30 = n - 5
	}
	if lo30 < 0 {
		lo30 = 0
	}
	maxRR := rrIntervals[lo30]
	for i := lo30; i <= hi30; i++ {
		if rrIntervals[i] > maxRR {
			maxRR = rrIntervals[i]
		}
	}
	// RR min around beat 15 (index 10..20)
	lo15 := 10
	hi15 := 20
	if hi15 >= n {
		hi15 = n - 1
	}
	minRR := rrIntervals[lo15]
	for i := lo15; i <= hi15 && i < n; i++ {
		if rrIntervals[i] < minRR {
			minRR = rrIntervals[i]
		}
	}

	res.RRMax30 = maxRR
	res.RRMin15 = minRR
	if minRR <= 0 {
		return res
	}
	res.Ratio30_15 = maxRR / minRR
	switch {
	case res.Ratio30_15 >= 1.04:
		res.Class = "Normal Parasympathetic Vagal Rebound"
		res.Normal = true
	case res.Ratio30_15 >= 1.01:
		res.Class = "Borderline Vagal Response"
		res.Normal = false
	default:
		res.Class = "Impaired Vagal Baroreflex"
		res.Normal = false
	}
	return res
}

// EvaluatePOTS evaluates orthostatic HR criteria.
func EvaluatePOTS(baselineHR, uprightHR float64, ageYears int, sustained bool) POTSAssessment {
	delta := uprightHR - baselineHR
	threshold := 30.0
	if ageYears > 0 && ageYears <= 19 {
		threshold = 40.0
	}
	meets := sustained && (delta >= threshold || uprightHR >= 120.0) && baselineHR > 0
	class := "Normal Orthostatic Response"
	if delta >= threshold || uprightHR >= 120.0 {
		if sustained {
			class = "Meets POTS Hemodynamic Criteria (screening)"
		} else {
			class = "Transient Orthostatic Tachycardia (not sustained)"
		}
	} else if delta >= 20 {
		class = "Mild Orthostatic Tachycardia"
	}
	return POTSAssessment{
		BaselineHR:    baselineHR,
		UprightHR:     uprightHR,
		DeltaHR:       delta,
		Sustained:     sustained,
		MeetsPOTSCrit: meets,
		Classification: class,
	}
}

// ComputePWV computes Moens-Korteweg PWV and Bramwell-Hill distensibility.
func ComputePWV(pathLengthM, pttMs float64) ArterialStiffness {
	if pttMs <= 0 {
		pttMs = 1
	}
	if pathLengthM <= 0 {
		pathLengthM = 0.5
	}
	pwv := pathLengthM / (pttMs / 1000.0)
	rho := 1060.0
	hOverD := 0.10
	eKPa := (rho * pwv * pwv / hOverD) / 1000.0
	dKPa := (1.0 / (rho * pwv * pwv)) * 1000.0
	vascularAge := math.Max(18, math.Min(95, 30.0+(pwv-6.0)*10.0))
	class := "Normal Elastic Arteries"
	if pwv >= 10.0 {
		class = "Clinically Elevated Arterial Stiffness"
	} else if pwv >= 8.0 {
		class = "Borderline Arterial Stiffening"
	}
	return ArterialStiffness{
		PTTms:             pttMs,
		PWVmPerS:          pwv,
		YoungsModulusKPa:  eKPa,
		DistensibilityKPa: dKPa,
		VascularAgeYears:  vascularAge,
		StiffnessClass:    class,
	}
}

// HughesExponentialBP estimates MBP excursion: MBP = MBP0 + (2/gamma)*ln(PTT0/PTT)
func HughesExponentialBP(mbp0, ptt0, ptt, gamma float64) float64 {
	if gamma == 0 {
		gamma = 0.017
	}
	if ptt0 <= 0 {
		ptt0 = 1
	}
	if ptt <= 0 {
		ptt = 1
	}
	return mbp0 + (2.0/gamma)*math.Log(ptt0/ptt)
}

// FitQCRT fits A(t) = Ablanch + (Abase-Ablanch)*(1-exp(-(t-t0)/tau))
// using a simple grid search + local refinement (Levenberg-Marquardt-lite).
// timesSec and values must be post-release samples starting at t>=0 relative to release.
func FitQCRT(timesSec, values []float64) QCRTResult {
	res := QCRTResult{Class: "Insufficient data"}
	n := len(timesSec)
	if n < 5 || len(values) != n {
		return res
	}
	// Estimate Ablanch as min, Abase as late mean
	ablanch := values[0]
	abase := values[n-1]
	for _, v := range values {
		if v < ablanch {
			ablanch = v
		}
	}
	// late average for Abase
	lateStart := int(float64(n) * 0.7)
	if lateStart < n-2 {
		s := 0.0
		c := 0
		for i := lateStart; i < n; i++ {
			s += values[i]
			c++
		}
		abase = s / float64(c)
	}
	amp := abase - ablanch
	if math.Abs(amp) < 1e-9 {
		res.TauSeconds = 0
		res.T90Seconds = 0
		res.R2 = 0
		res.Class = "No reperfusion signal"
		return res
	}

	// Grid search tau
	bestTau := 1.0
	bestSSE := math.MaxFloat64
	for t := 0.1; t <= 8.0; t += 0.05 {
		sse := 0.0
		for i := 0; i < n; i++ {
			pred := ablanch + amp*(1.0-math.Exp(-timesSec[i]/t))
			d := values[i] - pred
			sse += d * d
		}
		if sse < bestSSE {
			bestSSE = sse
			bestTau = t
		}
	}
	// Local refinement
	for step := 0.05; step > 0.001; step *= 0.5 {
		for _, delta := range []float64{-step, step} {
			cand := bestTau + delta
			if cand <= 0.01 || cand > 15.0 {
				continue
			}
			sse := 0.0
			for i := 0; i < n; i++ {
				pred := ablanch + amp*(1.0-math.Exp(-timesSec[i]/cand))
				d := values[i] - pred
				sse += d * d
			}
			if sse < bestSSE {
				bestSSE = sse
				bestTau = cand
			}
		}
	}

	// R2
	meanY := 0.0
	for _, v := range values {
		meanY += v
	}
	meanY /= float64(n)
	sst := 0.0
	for _, v := range values {
		d := v - meanY
		sst += d * d
	}
	r2 := 0.0
	if sst > 1e-12 {
		r2 = 1.0 - bestSSE/sst
	}
	if r2 < 0 {
		r2 = 0
	}

	t90 := 2.302585092994046 * bestTau // -ln(0.1)
	res.TauSeconds = bestTau
	res.T90Seconds = t90
	res.R2 = r2
	switch {
	case t90 < 2.0:
		res.Class = "Normal Euvolemic Microvascular Perfusion"
	case t90 <= 3.0:
		res.Class = "Borderline Delayed Refill"
	default:
		res.Class = "Significantly Prolonged Refill"
	}
	return res
}

// MedianFloat returns median of a slice (copies).
func MedianFloat(vals []float64) float64 {
	if len(vals) == 0 {
		return 0
	}
	cp := append([]float64(nil), vals...)
	sort.Float64s(cp)
	m := len(cp) / 2
	if len(cp)%2 == 1 {
		return cp[m]
	}
	return (cp[m-1] + cp[m]) / 2.0
}
