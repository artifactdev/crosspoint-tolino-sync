#include "TolinoPoint.h"
#include <cassert>
#include <fstream>
#include <iostream>

int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string file = argv[1];
  std::ofstream(file) << "<?xml version=\"1.0\"?><html>\n<head><title>T</title></head>\n"
                        "<body>\n<!--c--><p>Grüße 😀</p><?skip ignored?><p><b>Second</b></p></body></html>";
  std::string result, roundtrip;
  const std::string xpath = "/body/DocFragment[1]/body/p[1]/text()[1].6";
  assert(tolino::convertPoint(file, xpath, true, result));
  assert(result == "OPS/chapter.xhtml#point(/1/4/3/1:8)");
  assert(tolino::convertPoint(file, result, false, roundtrip));
  assert(roundtrip == xpath);
  assert(!tolino::convertPoint(file, "OPS/chapter.xhtml#point(/1/4/3/1:3)", false, roundtrip));
  assert(!tolino::convertPoint(file, "/body/DocFragment[2]/body/p[1]", true, roundtrip));
  assert(!tolino::convertPoint(file, "/body/DocFragment[1]/body/p[9]", true, roundtrip));
  assert(!tolino::convertPoint(file, "OPS/chapter.xhtml#point(/1/2/1/1:0)", false, roundtrip));
  assert(tolino::convertPoint(file, "OPS/chapter.xhtml#point(/1/4/4:3)", false, roundtrip));
  assert(roundtrip == "/body/DocFragment[1]/body/p[2]/b[1]/text()[1].3");
  std::ofstream(file) << "<html><body><p>Hi<![CDATA[CD]]>tail</p></body></html>";
  assert(tolino::convertPoint(file, "/body/DocFragment[1]/body/p[1]/text()[3].2", true, result));
  assert(result == "OPS/chapter.xhtml#point(/1/1/1/3:2)");
  assert(tolino::convertPoint(file, result, false, roundtrip));
  assert(roundtrip == "/body/DocFragment[1]/body/p[1]/text()[3].2");
  std::cout << "PASS: exact RMSDK/XPath conversion, whitespace/comments/PI/CDATA, Unicode offsets, invalid paths.\n";
}
