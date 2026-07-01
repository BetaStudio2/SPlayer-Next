cmake_minimum_required(VERSION 3.16)
project(splayer-scraper CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# ---------- 依赖 ----------
find_package(CURL REQUIRED)
find_package(OpenSSL REQUIRED)  # HTTPS + SHA1
find_package(SQLite3 REQUIRED)  # scraper-state.db 直写
# Taglib：优先 Config 模式（Arch Linux 自带 taglib-config.cmake）
# 失败后回退 FindTaglib.cmake（pkg-config 检测，适用 Alpine）
find_package(TagLib CONFIG QUIET)
if(NOT TARGET TagLib::tag)
    find_package(Taglib CONFIG QUIET)
endif()

if(TARGET TagLib::tag AND NOT TARGET Taglib::tag)
    add_library(Taglib::tag ALIAS TagLib::tag)
elseif(TARGET taglib::tag AND NOT TARGET Taglib::tag)
    add_library(Taglib::tag ALIAS taglib::tag)
endif()

if(NOT TARGET Taglib::tag)
    list(APPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_SOURCE_DIR}/cmake")
    find_package(Taglib REQUIRED)
endif()

# nlohmann/json：header-only，优先用系统包，否则 fetch
find_package(nlohmann_json 3.10.0 QUIET)
if(NOT nlohmann_json_FOUND)
    message(STATUS "nlohmann_json 未找到，从 FetchContent 获取")
    include(FetchContent)
    FetchContent_Declare(
        nlohmann_json
        GIT_REPOSITORY https://github.com/nlohmann/json.git
        GIT_TAG v3.11.3
        GIT_SHALLOW TRUE
    )
    FetchContent_MakeAvailable(nlohmann_json)
endif()

# ---------- 编译选项 ----------
add_compile_options(-Wall -Wextra -Wpedantic)
if(CMAKE_BUILD_TYPE STREQUAL "Debug")
    add_compile_options(-g -O0)
else()
    add_compile_options(-O2)
endif()

# ---------- 可执行文件 ----------
add_executable(splayer-scraper
    src/main.cpp
)

target_include_directories(splayer-scraper PRIVATE include)

target_link_libraries(splayer-scraper PRIVATE
    CURL::libcurl
    OpenSSL::Crypto
    SQLite::SQLite3
    nlohmann_json::nlohmann_json
    Taglib::tag
)

# 安装目标
install(TARGETS splayer-scraper RUNTIME DESTINATION bin)
