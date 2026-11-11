#pragma once
#include <cstdint>
#include <fstream>
#include <string>

class Print {
 public:
  virtual ~Print() = default;
  virtual size_t write(uint8_t) = 0;
  virtual size_t write(const uint8_t*, size_t) = 0;
};

class Epub {
  std::string file;
 public:
  struct Spine { std::string href; };
  Epub(const std::string& path, const char*) : file(path) {}
  void setupCacheDir() {}
  bool load(bool, bool) { return std::ifstream(file).good(); }
  int getSpineItemsCount() const { return 1; }
  Spine getSpineItem(int) const { return {"OPS/chapter.xhtml"}; }
  bool readItemContentsToStream(const std::string&, Print& output, size_t) {
    std::ifstream input(file);
    char data[7];
    while (input.read(data, sizeof data) || input.gcount()) {
      const auto size = static_cast<size_t>(input.gcount());
      if (output.write(reinterpret_cast<const uint8_t*>(data), size) != size) return false;
    }
    return true;
  }
};
