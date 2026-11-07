// test/support/go-tlog/main.go — 투명성 로그 **세 번째 독립 검증**(ADR-0008 §2.6 · F28): Go `golang.org/x/mod/sumdb/{tlog,note}`.
//
// 테스트(`test/unit/tlog/go-crosscheck.test.ts`)가 Go 설치본에 들어 있는 x/mod 사본(`$GOROOT/src/cmd/vendor/golang.org/x/mod/sumdb`)을
// 임시 모듈의 third_party 로 복사하고 이 파일을 `go run` 한다 — 네트워크 0 · 리포에 제3자 코드 0. Go 가 없으면 테스트가 건너뛴다.
//
// 입력 JSON(argv[1]):
//   - entries/cases/tiles: TS(src/tlog)가 만든 포함·일관성 증명 · 변조 증명의 판정 · C2SP 타일 — Go 의 ProveRecord/ProveTree/CheckRecord/
//     CheckTree/ReadTileData 와 대조(불일치 = disagreements).
//   - vkeys: TS vkeyOf 의 출력 — note.NewVerifier 가 전부 받아야 한다(H1: 키 자료에 '+').
//   - vkey/notes: TS 가 서명한 체크포인트 — note.Open 으로 연다.
//   - bundles: `atmark-tlog-bundle/v2` — 체크포인트(note.Open) · 전역 포함(CheckRecord) · 전역 일관성(CheckTree) · 에폭 트리 잎
//     {epoch, log, root, size}(v2) 포함 · 가장자리+잎으로 헤드 재계산 · 조직 일관성 · link · 빠짐(체크포인트 누락 · to 헤드 · 시작 헤드).
// 출력(stdout): JSON {disagreements, counts, bundles: [{name, errors}]}.
package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"atmarkgo/third_party/note"
	"atmarkgo/third_party/tlog"
)

type Mut struct {
	Kind  string   `json:"kind"`
	Proof []string `json:"proof"`
	TS    bool     `json:"ts"`
}
type Incl struct {
	I     int64    `json:"i"`
	Proof []string `json:"proof"`
	Muts  []Mut    `json:"muts"`
}
type Cons struct {
	M     int64    `json:"m"`
	R1    string   `json:"r1"`
	Proof []string `json:"proof"`
	Muts  []Mut    `json:"muts"`
}
type Case struct {
	N    int64  `json:"n"`
	Root string `json:"root"`
	Incl []Incl `json:"incl"`
	Cons []Cons `json:"cons"`
}
type TileV struct {
	N     int64  `json:"n"`
	Path  string `json:"path"`
	Bytes string `json:"bytes"`
}
type NoteV struct {
	N    int64  `json:"n"`
	Note string `json:"note"`
}
type Link struct {
	FromSize int64    `json:"from_size"`
	ToSize   int64    `json:"to_size"`
	Proof    []string `json:"proof"`
}
type Bundle struct {
	Format string `json:"format"`
	Origin string `json:"origin"`
	Vkey   string `json:"vkey"`
	Org    struct {
		Log string `json:"log"`
	} `json:"org"`
	Range struct {
		From int64 `json:"from_epoch"`
		To   int64 `json:"to_epoch"`
	} `json:"range"`
	Start struct {
		Size     int64 `json:"size"`
		Frontier []struct {
			Height int    `json:"height"`
			Hash   string `json:"hash"`
		} `json:"frontier"`
	} `json:"start"`
	Leaves []struct {
		Seq  int64  `json:"seq"`
		Leaf string `json:"leaf"`
	} `json:"leaves"`
	Heads []struct {
		Epoch      int64    `json:"epoch"`
		Size       int64    `json:"size"`
		Root       string   `json:"root"`
		Position   int64    `json:"position"`
		EpochSize  int64    `json:"epoch_size"`
		EpochProof []string `json:"epoch_proof"`
	} `json:"heads"`
	Checkpoints []struct {
		Epoch      int64    `json:"epoch"`
		Note       string   `json:"note"`
		GlobalLeaf string   `json:"global_leaf"`
		Inclusion  []string `json:"inclusion"`
	} `json:"checkpoints"`
	GlobalConsistency []struct {
		From  int64    `json:"from"`
		To    int64    `json:"to"`
		Proof []string `json:"proof"`
	} `json:"global_consistency"`
	OrgConsistency *Link `json:"org_consistency"`
	Link           *struct {
		Epoch     int64  `json:"epoch"`
		Direction string `json:"direction"`
		Global    Link   `json:"global"`
		Org       *Link  `json:"org"`
	} `json:"link"`
}
type NamedBundle struct {
	Name   string `json:"name"`
	Bundle Bundle `json:"bundle"`
	// 저장 상태(링크 검사) — 없으면 0.
	SavedEpoch int64  `json:"savedEpoch"`
	SavedRoot  string `json:"savedRoot"`
}
type Input struct {
	Entries []string      `json:"entries"`
	Cases   []Case        `json:"cases"`
	Tiles   []TileV       `json:"tiles"`
	Vkeys   []string      `json:"vkeys"`
	Vkey    string        `json:"vkey"`
	Notes   []NoteV       `json:"notes"`
	Bundles []NamedBundle `json:"bundles"`
}
type BundleResult struct {
	Name   string   `json:"name"`
	Errors []string `json:"errors"`
}
type Output struct {
	Disagreements []string       `json:"disagreements"`
	Counts        map[string]int `json:"counts"`
	Bundles       []BundleResult `json:"bundles"`
}

func h(s string) (tlog.Hash, bool) {
	var x tlog.Hash
	b, err := hex.DecodeString(s)
	if err != nil || len(b) != len(x) {
		return x, false
	}
	copy(x[:], b)
	return x, true
}

func hs(ss []string) []tlog.Hash {
	out := make([]tlog.Hash, len(ss))
	for i, s := range ss {
		out[i], _ = h(s)
	}
	return out
}

func main() {
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var in Input
	if err := json.Unmarshal(raw, &in); err != nil {
		panic(err)
	}
	out := Output{Disagreements: []string{}, Counts: map[string]int{}, Bundles: []BundleResult{}}
	disagree := func(f string, a ...any) { out.Disagreements = append(out.Disagreements, fmt.Sprintf(f, a...)) }

	// ── 머클 증명 · 타일 ────────────────────────────────────────────────
	entries := make([][]byte, len(in.Entries))
	for i, e := range in.Entries {
		entries[i], _ = base64.StdEncoding.DecodeString(e)
	}
	var stored []tlog.Hash
	hr := tlog.HashReaderFunc(func(idx []int64) ([]tlog.Hash, error) {
		res := make([]tlog.Hash, len(idx))
		for i, x := range idx {
			res[i] = stored[x]
		}
		return res, nil
	})
	for n := range entries {
		add, err := tlog.StoredHashes(int64(n), entries[n], hr)
		if err != nil {
			panic(err)
		}
		stored = append(stored, add...)
	}
	for _, c := range in.Cases {
		if c.N == 0 {
			continue
		}
		th, err := tlog.TreeHash(c.N, hr)
		if err != nil {
			panic(err)
		}
		if hex.EncodeToString(th[:]) != c.Root {
			disagree("root n=%d", c.N)
		}
		for _, inc := range c.Incl {
			out.Counts["inclusion"]++
			lh := tlog.RecordHash(entries[inc.I])
			gp, _ := tlog.ProveRecord(c.N, inc.I, hr)
			if strings.Join(hexes(gp), ",") != strings.Join(inc.Proof, ",") {
				disagree("inclusion proof differs n=%d i=%d", c.N, inc.I)
			}
			if tlog.CheckRecord(hs(inc.Proof), c.N, th, inc.I, lh) != nil {
				disagree("inclusion rejected by go n=%d i=%d", c.N, inc.I)
			}
			for _, m := range inc.Muts {
				out.Counts["mutations"]++
				if (tlog.CheckRecord(hs(m.Proof), c.N, th, inc.I, lh) == nil) != m.TS {
					disagree("inclusion mutation %s n=%d i=%d ts=%v", m.Kind, c.N, inc.I, m.TS)
				}
			}
		}
		for _, cs := range c.Cons {
			out.Counts["consistency"]++
			if cs.M == 0 {
				continue
			}
			old, _ := tlog.TreeHash(cs.M, hr)
			if hex.EncodeToString(old[:]) != cs.R1 {
				disagree("old root n=%d m=%d", c.N, cs.M)
			}
			gp, _ := tlog.ProveTree(c.N, cs.M, hr)
			if strings.Join(hexes(gp), ",") != strings.Join(cs.Proof, ",") {
				disagree("consistency proof differs n=%d m=%d", c.N, cs.M)
			}
			if tlog.CheckTree(hs(cs.Proof), c.N, th, cs.M, old) != nil {
				disagree("consistency rejected by go n=%d m=%d", c.N, cs.M)
			}
			for _, m := range cs.Muts {
				out.Counts["mutations"]++
				if (tlog.CheckTree(hs(m.Proof), c.N, th, cs.M, old) == nil) != m.TS {
					disagree("consistency mutation %s n=%d m=%d ts=%v", m.Kind, c.N, cs.M, m.TS)
				}
			}
		}
	}
	for _, t := range in.Tiles {
		out.Counts["tiles"]++
		b, _ := base64.StdEncoding.DecodeString(t.Bytes)
		if strings.HasPrefix(t.Path, "tile/entries/") {
			gt, err := tlog.ParseTilePath("tile/8/data/" + strings.TrimPrefix(t.Path, "tile/entries/"))
			if err != nil {
				disagree("entries path %s", t.Path)
				continue
			}
			var want bytes.Buffer
			for i := gt.N * 256; i < gt.N*256+int64(gt.W); i++ {
				var l [2]byte
				binary.BigEndian.PutUint16(l[:], uint16(len(entries[i])))
				want.Write(l[:])
				want.Write(entries[i])
			}
			if !bytes.Equal(want.Bytes(), b) {
				disagree("entries content %s", t.Path)
			}
			continue
		}
		gt, err := tlog.ParseTilePath("tile/8/" + strings.TrimPrefix(t.Path, "tile/"))
		if err != nil {
			disagree("tile path %s", t.Path)
			continue
		}
		want, err := tlog.ReadTileData(gt, hr)
		if err != nil || !bytes.Equal(want, b) {
			disagree("tile content %s n=%d", t.Path, t.N)
		}
	}

	// ── vkey · signed note ─────────────────────────────────────────────
	for _, vk := range in.Vkeys {
		out.Counts["vkeys"]++
		if _, err := note.NewVerifier(vk); err != nil {
			disagree("go rejects TS vkey %s: %v", vk, err)
		}
	}
	if in.Vkey != "" {
		v, err := note.NewVerifier(in.Vkey)
		if err != nil {
			disagree("vkey: %v", err)
		} else {
			for _, nv := range in.Notes {
				out.Counts["notes"]++
				n, err := note.Open([]byte(nv.Note), note.VerifierList(v))
				if err != nil || strings.Split(n.Text, "\n")[1] != strconv.FormatInt(nv.N, 10) {
					disagree("note n=%d: %v", nv.N, err)
				}
			}
		}
	}

	// ── 번들 ────────────────────────────────────────────────────────────
	for _, nb := range in.Bundles {
		out.Bundles = append(out.Bundles, BundleResult{Name: nb.Name, Errors: verifyBundle(nb)})
	}
	enc, _ := json.Marshal(out)
	fmt.Println(string(enc))
}

func hexes(list []tlog.Hash) []string {
	res := make([]string, len(list))
	for i, x := range list {
		res[i] = hex.EncodeToString(x[:])
	}
	return res
}

type opened struct {
	size int64
	root tlog.Hash
}

func verifyBundle(nb NamedBundle) []string {
	b := nb.Bundle
	errs := []string{}
	fail := func(f string, a ...any) { errs = append(errs, fmt.Sprintf(f, a...)) }
	if b.Format != "atmark-tlog-bundle/v2" {
		return []string{"format"}
	}
	v, err := note.NewVerifier(b.Vkey)
	if err != nil {
		return []string{"vkey"}
	}
	if v.Name() != b.Origin {
		fail("vkey_origin")
	}
	cps := map[int64]opened{}
	epochRoots := map[int64]tlog.Hash{}
	for _, cp := range b.Checkpoints {
		n, err := note.Open([]byte(cp.Note), note.VerifierList(v))
		if err != nil {
			fail("signature:%d", cp.Epoch)
			continue
		}
		lines := strings.Split(n.Text, "\n")
		size, err := strconv.ParseInt(lines[1], 10, 64)
		rootBytes, err2 := base64.StdEncoding.DecodeString(lines[2])
		if lines[0] != b.Origin || err != nil || err2 != nil || len(rootBytes) != 32 || size != cp.Epoch+1 {
			fail("checkpoint_text:%d", cp.Epoch)
			continue
		}
		var root tlog.Hash
		copy(root[:], rootBytes)
		var gl struct {
			V         int64  `json:"v"`
			Kind      string `json:"kind"`
			Epoch     int64  `json:"epoch"`
			ClosedAt  string `json:"closed_at"`
			EpochRoot string `json:"epoch_root"`
		}
		if json.Unmarshal([]byte(cp.GlobalLeaf), &gl) != nil || gl.V != 2 || gl.Kind != "epoch" || gl.Epoch != cp.Epoch {
			fail("global_leaf:%d", cp.Epoch)
			continue
		}
		canonical := fmt.Sprintf(`{"closed_at":%q,"epoch":%d,"epoch_root":%q,"kind":"epoch","v":2}`, gl.ClosedAt, gl.Epoch, gl.EpochRoot)
		if canonical != cp.GlobalLeaf {
			fail("global_leaf_canonical:%d", cp.Epoch)
		}
		if tlog.CheckRecord(hs(cp.Inclusion), size, root, cp.Epoch, tlog.RecordHash([]byte(cp.GlobalLeaf))) != nil {
			fail("global_inclusion:%d", cp.Epoch)
		}
		cps[cp.Epoch] = opened{size, root}
		epochRoots[cp.Epoch], _ = h(gl.EpochRoot)
	}
	for e := b.Range.From; e <= b.Range.To; e++ {
		if _, ok := cps[e]; !ok {
			fail("checkpoint_missing:%d", e)
		}
	}
	for e := b.Range.From; e < b.Range.To; e++ {
		a, okA := cps[e]
		c, okC := cps[e+1]
		found := false
		for _, gc := range b.GlobalConsistency {
			if gc.From == e+1 && gc.To == e+2 && okA && okC {
				found = true
				if tlog.CheckTree(hs(gc.Proof), c.size, c.root, a.size, a.root) != nil {
					fail("global_consistency:%d", e)
				}
			}
		}
		if !found {
			fail("global_consistency_missing:%d", e)
		}
	}
	// 조직: 가장자리 + 잎 → 크기별 루트(스택 접기 — Go 쪽 독립 구현).
	type node struct {
		height int
		hash   tlog.Hash
	}
	stack := []node{}
	for _, f := range b.Start.Frontier {
		x, _ := h(f.Hash)
		stack = append(stack, node{f.Height, x})
	}
	fold := func(st []node) tlog.Hash {
		if len(st) == 0 {
			return tlog.Hash(sha256.Sum256(nil))
		}
		acc := st[len(st)-1].hash
		for i := len(st) - 2; i >= 0; i-- {
			acc = tlog.NodeHash(st[i].hash, acc)
		}
		return acc
	}
	roots := map[int64]tlog.Hash{b.Start.Size: fold(stack)}
	for i, l := range b.Leaves {
		if l.Seq != b.Start.Size+int64(i) {
			fail("leaf_seq:%d", l.Seq)
		}
		cur := node{0, tlog.RecordHash([]byte(l.Leaf))}
		for len(stack) > 0 && stack[len(stack)-1].height == cur.height {
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			cur = node{cur.height + 1, tlog.NodeHash(top.hash, cur.hash)}
		}
		stack = append(stack, cur)
		roots[b.Start.Size+int64(i)+1] = fold(stack)
	}
	heads := map[int64]int64{}
	for _, hd := range b.Heads {
		heads[hd.Epoch] = hd.Size
		root, ok := roots[hd.Size]
		want, _ := h(hd.Root)
		if !ok || root != want {
			fail("head_root:%d", hd.Epoch)
		}
		leaf := fmt.Sprintf(`{"epoch":%d,"log":%q,"root":%q,"size":%d}`, hd.Epoch, b.Org.Log, hd.Root, hd.Size)
		er, ok := epochRoots[hd.Epoch]
		if !ok || tlog.CheckRecord(hs(hd.EpochProof), hd.EpochSize, er, hd.Position, tlog.RecordHash([]byte(leaf))) != nil {
			fail("head_epoch:%d", hd.Epoch)
		}
	}
	if b.Start.Size > 0 {
		if s, ok := heads[b.Range.From]; !ok || s != b.Start.Size {
			fail("start_head")
		}
	}
	if len(b.Leaves) > 0 {
		if _, ok := heads[b.Range.To]; !ok {
			fail("to_head")
		}
	}
	checkLink := func(label string, l *Link, rootFrom, rootTo tlog.Hash) {
		if l.FromSize == 0 {
			if len(l.Proof) != 0 {
				fail("%s", label)
			}
			return
		}
		if tlog.CheckTree(hs(l.Proof), l.ToSize, rootTo, l.FromSize, rootFrom) != nil {
			fail("%s", label)
		}
	}
	if b.OrgConsistency != nil {
		ra, okA := roots[b.OrgConsistency.FromSize]
		rb, okB := roots[b.OrgConsistency.ToSize]
		if !okA || !okB {
			fail("org_consistency")
		} else {
			checkLink("org_consistency", b.OrgConsistency, ra, rb)
		}
	}
	// 저장 상태(since) — 전역 링크만(조직 링크는 TS 두 검증기가 본다).
	if nb.SavedRoot != "" {
		saved, _ := h(nb.SavedRoot)
		if b.Link == nil || b.Link.Epoch != nb.SavedEpoch {
			if nb.SavedEpoch < b.Range.From || nb.SavedEpoch > b.Range.To {
				fail("state_unlinked")
			} else if cps[nb.SavedEpoch].root != saved {
				fail("state_checkpoint")
			}
		} else if b.Link.Direction == "forward" {
			checkLink("state_link", &b.Link.Global, saved, cps[b.Range.From].root)
		} else {
			checkLink("state_link", &b.Link.Global, cps[b.Range.To].root, saved)
		}
	}
	return errs
}
