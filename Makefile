.PHONY: build serve publish-ipfs clean distclean

HOME_RS := $(shell find src -type f -name '*.rs')
DID_MA_RS := $(shell find ../ma/src -type f -name '*.rs')
MA_ACTOR_RS := $(shell find ../ma-actor/src -type f -name '*.rs')
BUILD_INPUTS := Makefile Cargo.toml Cargo.lock ../ma/Cargo.toml ../ma/Cargo.lock ../ma-actor/Cargo.toml $(HOME_RS) $(DID_MA_RS) $(MA_ACTOR_RS)

PKG_STAMP := www/pkg/.stamp


build: $(PKG_STAMP)

$(PKG_STAMP): $(BUILD_INPUTS)
	wasm-pack build --dev --target web --out-dir www/pkg
	touch $(PKG_STAMP)

serve: build
	cd www && python3 -m http.server 8081

publish-ipfs: build
	@cid=$$(ipfs add -Qr www); \
	echo "Published ma-home webapp bundle to IPFS:"; \
	echo "  CID: $$cid"; \
	echo "  Gateway URL: http://127.0.0.1:8080/ipfs/$$cid/"; \
	echo "  Public gateway: https://ipfs.io/ipfs/$$cid/"

clean:
	rm -rf www/pkg

distclean: clean
	cargo clean
