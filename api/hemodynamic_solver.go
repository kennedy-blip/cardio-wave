package handler

import (
	"encoding/json"
	"math"
	"net/http"
	"sort"
)

// Request is the generic solver input. Different modules populate relevant fields.
type Request struct {
	Module string `json:"module"`

	// SCG/Tei
	IVCTms float64 `json:"ivctMs"`
	LVETms float64 `json:"lvetMs"`
	IVRTms float64 `json:"ivrtMs"`

	// PWV
	PathLengthM float64 `json:"pathLengthM"`
	PTTms       float64 `json:"pttMs"`
	MBP0        float64 `json:"mbp0"`
	PTT0ms      float64 `json:"ptt0Ms"`
	Gamma       float64 `json:"gamma"`

	// Orthostatic / HRV
	RRIntervalsMs []float64 `json:"rrIntervalsMs"`
	BaselineHR    float64   `json:"baselineHrBpm"`
	UprightHR     float64   `json:"uprightHrBpm"`
	AgeYears      int       `json:"ageYears"`
	Sustained     bool      `json:"sustained"`

	// qCRT
	TimesSec []float64 `json:"timesSec"`
	Values   []float64 `json:"values"`
}

type Response struct {
	OK     bool                   `json:"ok"`
	Module string                 `json:"module"`
	Result map[string]interface{} `json:"result"`
	Error  string                 `json:"error,omitempty"`
}

func Handler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
	w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	if r.Method != http.MethodPost {
		w.WriteHeader(http.StatusMethodNotAllowed)
		json.NewEncoder(w).Encode(Response{OK: false, Error: "POST required"})
		return
	}
	defer r.Body.Close()
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(Response{OK: false, Error: "invalid JSON"})
		return
	}

	result := map[string]interface{}{}
	switch req.Module {
	case "scg_tei":
		lvet := req.LVETms
		if math.Abs(lvet) < 1e-9 {
			lvet = 1e-9
		}
		tei := (req.IVCTms + req.IVRTms) / lvet
		pepLvet := req.IVCTms / lvet
		class := "Normal Myocardial Performance"
		if tei > 0.50 {
			class = "Elevated Tei Index - Combined Systolic/Diastolic Dysfunction Pattern"
		} else if tei > 0.40 {
			class = "Borderline Myocardial Performance"
		}
		result["ivctMs"] = req.IVCTms
		result["lvetMs"] = req.LVETms
		result["ivrtMs"] = req.IVRTms
		result["teiIndex"] = tei
		result["pepLvetRatio"] = pepLvet
		result["classification"] = class

	case "pwv":
		ptt := req.PTTms
		if ptt <= 0 {
			ptt = 1
		}
		l := req.PathLengthM
		if l <= 0 {
			l = 0.5
		}
		pwv := l / (ptt / 1000.0)
		rho := 1060.0
		hOverD := 0.10
		eKPa := (rho * pwv * pwv / hOverD) / 1000.0
		dKPa := (1.0 / (rho * pwv * pwv)) * 1000.0
		va := clamp(30.0+(pwv-6.0)*10.0, 18.0, 95.0)
		class := "Normal Elastic Arteries"
		if pwv >= 10.0 {
			class = "Clinically Elevated Arterial Stiffness"
		} else if pwv >= 8.0 {
			class = "Borderline Arterial Stiffening"
		}
		mbpEst := req.MBP0
		gamma := req.Gamma
		if gamma == 0 {
			gamma = 0.017
		}
		if req.PTT0ms > 0 && req.MBP0 > 0 {
			mbpEst = req.MBP0 + (2.0/gamma)*math.Log(req.PTT0ms/ptt)
		}
		result["pttMs"] = ptt
		result["pwvMPerS"] = pwv
		result["youngsModulusKPa"] = eKPa
		result["distensibilityPerKPa"] = dKPa
		result["vascularAgeYears"] = va
		result["stiffnessClass"] = class
		result["mbpEstimate"] = mbpEst

	case "orthostatic_hrv":
		hrv := computeHRV(req.RRIntervalsMs)
		ewing := evaluateEwing(req.RRIntervalsMs)
		pots := evaluatePOTS(req.BaselineHR, req.UprightHR, req.AgeYears, req.Sustained)
		result["hrv"] = hrv
		result["ewing30_15"] = ewing
		result["pots"] = pots

	case "qcrt":
		qcrt := fitQCRT(req.TimesSec, req.Values)
		result["qcrt"] = qcrt

	default:
		// return a combined lightweight audit
		result["message"] = "Specify module: scg_tei | pwv | orthostatic_hrv | qcrt"
		result["supportedModules"] = []string{"scg_tei", "pwv", "orthostatic_hrv", "qcrt"}
	}

	json.NewEncoder(w).Encode(Response{OK: true, Module: req.Module, Result: result})
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func computeHRV(rr []float64) map[string]interface{} {
	out := map[string]interface{}{"sampleCount": len(rr)}
	if len(rr) < 4 {
		return out
	}
	sum := 0.0
	for _, v := range rr {
		sum += v
	}
	mean := sum / float64(len(rr))
	sdnnAcc := 0.0
	for _, v := range rr {
		d := v - mean
		sdnnAcc += d * d
	}
	sdnn := math.Sqrt(sdnnAcc / float64(len(rr)))
	rmssdAcc := 0.0
	for i := 1; i < len(rr); i++ {
		d := rr[i] - rr[i-1]
		rmssdAcc += d * d
	}
	rmssd := math.Sqrt(rmssdAcc / float64(len(rr)-1))
	meanHR := 0.0
	if mean > 0 {
		meanHR = 60000.0 / mean
	}

	// Build times
	t := make([]float64, len(rr))
	acc := 0.0
	for i, v := range rr {
		t[i] = acc
		acc += v / 1000.0
	}
	freqs, powers := lombScargle(t, rr, 0.003, 0.40, 0.002)
	vlf := integrateBand(freqs, powers, 0.003, 0.04)
	lf := integrateBand(freqs, powers, 0.04, 0.15)
	hf := integrateBand(freqs, powers, 0.15, 0.40)
	ratio := 0.0
	if hf > 1e-12 {
		ratio = lf / hf
	}
	out["meanRrMs"] = mean
	out["meanHrBpm"] = meanHR
	out["sdnnMs"] = sdnn
	out["rmssdMs"] = rmssd
	out["vlfPower"] = vlf
	out["lfPower"] = lf
	out["hfPower"] = hf
	out["lfHfRatio"] = ratio
	return out
}

func lombScargle(times, values []float64, fMin, fMax, fStep float64) ([]float64, []float64) {
	n := len(times)
	if n < 4 || n != len(values) {
		return nil, nil
	}
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
	var freqs, powers []float64
	twoPi := 2 * math.Pi
	for f := fMin; f <= fMax; f += fStep {
		omega := twoPi * f
		var s2, c2 float64
		for i := 0; i < n; i++ {
			arg := 2 * omega * times[i]
			s2 += math.Sin(arg)
			c2 += math.Cos(arg)
		}
		tau := math.Atan2(s2, c2) / (2 * omega)
		var cs, ss, cd, sd float64
		for i := 0; i < n; i++ {
			arg := omega * (times[i] - tau)
			c := math.Cos(arg)
			s := math.Sin(arg)
			cs += y[i] * c
			ss += y[i] * s
			cd += c * c
			sd += s * s
		}
		if cd < 1e-18 || sd < 1e-18 {
			continue
		}
		p := 0.5 * ((cs*cs)/cd + (ss*ss)/sd) / variance
		freqs = append(freqs, f)
		powers = append(powers, p)
	}
	return freqs, powers
}

func integrateBand(freqs, powers []float64, lo, hi float64) float64 {
	area := 0.0
	for i := 0; i+1 < len(freqs); i++ {
		f0, f1 := freqs[i], freqs[i+1]
		p0, p1 := powers[i], powers[i+1]
		l := math.Max(f0, lo)
		h := math.Min(f1, hi)
		if h <= l {
			continue
		}
		df := f1 - f0
		if df <= 0 {
			continue
		}
		interp := func(f float64) float64 { return p0 + (f-f0)/df*(p1-p0) }
		area += 0.5 * (interp(l) + interp(h)) * (h - l)
	}
	if area < 0 {
		return 0
	}
	return area
}

func evaluateEwing(rr []float64) map[string]interface{} {
	out := map[string]interface{}{"classification": "Insufficient data"}
	n := len(rr)
	if n < 20 {
		return out
	}
	lo30, hi30 := 25, 35
	if hi30 >= n {
		hi30 = n - 1
	}
	if lo30 >= n {
		lo30 = n - 5
	}
	if lo30 < 0 {
		lo30 = 0
	}
	maxRR := rr[lo30]
	for i := lo30; i <= hi30; i++ {
		if rr[i] > maxRR {
			maxRR = rr[i]
		}
	}
	lo15, hi15 := 10, 20
	if hi15 >= n {
		hi15 = n - 1
	}
	minRR := rr[lo15]
	for i := lo15; i <= hi15 && i < n; i++ {
		if rr[i] < minRR {
			minRR = rr[i]
		}
	}
	if minRR <= 0 {
		return out
	}
	ratio := maxRR / minRR
	class := "Impaired Vagal Baroreflex"
	normal := false
	if ratio >= 1.04 {
		class = "Normal Parasympathetic Vagal Rebound"
		normal = true
	} else if ratio >= 1.01 {
		class = "Borderline Vagal Response"
	}
	out["rrMax30Ms"] = maxRR
	out["rrMin15Ms"] = minRR
	out["ratio30_15"] = ratio
	out["classification"] = class
	out["normal"] = normal
	return out
}

func evaluatePOTS(baselineHR, uprightHR float64, age int, sustained bool) map[string]interface{} {
	delta := uprightHR - baselineHR
	threshold := 30.0
	if age > 0 && age <= 19 {
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
	return map[string]interface{}{
		"baselineHrBpm":  baselineHR,
		"uprightHrBpm":   uprightHR,
		"deltaHrBpm":     delta,
		"sustained":      sustained,
		"meetsPotsCriteria": meets,
		"classification": class,
	}
}

func fitQCRT(times, values []float64) map[string]interface{} {
	out := map[string]interface{}{"classification": "Insufficient data"}
	n := len(times)
	if n < 5 || len(values) != n {
		return out
	}
	ablanch := values[0]
	abase := values[n-1]
	for _, v := range values {
		if v < ablanch {
			ablanch = v
		}
	}
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
		out["classification"] = "No reperfusion signal"
		out["tauSeconds"] = 0.0
		out["t90Seconds"] = 0.0
		out["r2"] = 0.0
		return out
	}
	bestTau := 1.0
	bestSSE := math.MaxFloat64
	for tau := 0.1; tau <= 8.0; tau += 0.05 {
		sse := 0.0
		for i := 0; i < n; i++ {
			pred := ablanch + amp*(1.0-math.Exp(-times[i]/tau))
			d := values[i] - pred
			sse += d * d
		}
		if sse < bestSSE {
			bestSSE = sse
			bestTau = tau
		}
	}
	for step := 0.05; step > 0.001; step *= 0.5 {
		for _, delta := range []float64{-step, step} {
			cand := bestTau + delta
			if cand <= 0.01 || cand > 15.0 {
				continue
			}
			sse := 0.0
			for i := 0; i < n; i++ {
				pred := ablanch + amp*(1.0-math.Exp(-times[i]/cand))
				d := values[i] - pred
				sse += d * d
			}
			if sse < bestSSE {
				bestSSE = sse
				bestTau = cand
			}
		}
	}
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
	t90 := 2.302585092994046 * bestTau
	class := "Normal Euvolemic Microvascular Perfusion"
	if t90 >= 3.0 {
		class = "Significantly Prolonged Refill"
	} else if t90 >= 2.0 {
		class = "Borderline Delayed Refill"
	}
	out["tauSeconds"] = bestTau
	out["t90Seconds"] = t90
	out["r2"] = r2
	out["classification"] = class
	out["aBlanch"] = ablanch
	out["aBase"] = abase
	return out
}

// ensure sort is used to satisfy compiler in case of future extensions
var _ = sort.Float64s
