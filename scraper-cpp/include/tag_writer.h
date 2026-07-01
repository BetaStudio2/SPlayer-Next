#pragma once

/// SPlayer 刮削器 —— TagLib 标签写入器（header-only）
///
/// 将刮削结果写入音频文件的元数据标签（ID3v2、Vorbis Comments、MP4 等）
/// 支持格式：MP3、FLAC、OGG、M4A、AAC、WAV 等
///
/// 写入内容：
/// - 基本元数据：title / artist / album / genre / year / track
/// - 扩展元数据：albumArtist / composer / discNumber / lyrics
/// - MusicBrainz 标识符：MBID / albumMbid / artistMbid / ISRC
///   这些标识符是判断文件是否已刮削的可靠依据

#include "scraper.h"
#include <taglib/tag.h>
#include <taglib/fileref.h>
#include <taglib/mpegfile.h>
#include <taglib/id3v2tag.h>
#include <taglib/id3v2frame.h>
#include <taglib/attachedpictureframe.h>
#include <taglib/textidentificationframe.h>
#include <taglib/unsynchronizedlyricsframe.h>
#include <taglib/commentsframe.h>
#include <taglib/flacfile.h>
#include <taglib/flacpicture.h>
#include <taglib/vorbisfile.h>
#include <taglib/opusfile.h>
#include <taglib/oggfile.h>
#include <taglib/xiphcomment.h>
#include <taglib/mp4file.h>
#include <taglib/mp4tag.h>
#include <taglib/mp4coverart.h>
#include <taglib/mp4item.h>
#include <stdexcept>
#include <algorithm>

namespace splayer::scraper {

class TagWriter {
public:
    TagWriter() = default;
    ~TagWriter() = default;

    TagWriter(const TagWriter&) = delete;
    TagWriter& operator=(const TagWriter&) = delete;

    /// 将刮削结果写入音频文件
    bool writeToFile(const std::string& filePath, const ScrapeResult& result,
                     const ScraperConfig& cfg) {
        try {
            std::string ext = filePath.substr(filePath.find_last_of('.') + 1);
            std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
            
            bool success = false;
            
            if (ext == "mp3") {
                success = writeMp3(filePath, result, cfg);
            } else if (ext == "flac") {
                success = writeFlac(filePath, result, cfg);
            } else if (ext == "ogg" || ext == "oga" || ext == "opus") {
                success = writeOgg(filePath, result, cfg);
            } else if (ext == "m4a" || ext == "aac" || ext == "mp4") {
                success = writeMp4(filePath, result, cfg);
            } else {
                // 对于其他格式，回退到使用 FileRef
                success = writeGeneric(filePath, result, cfg);
            }
            
            if (!success) {
                return false;
            }
            
            return true;
        } catch (const std::exception& e) {
            lastError_ = std::string("标签写入异常: ") + e.what();
            return false;
        }
    }

    const std::string& lastError() const { return lastError_; }
    
private:
    /// 直接写入 MP3 文件（ID3v2）
    bool writeMp3(const std::string& filePath, const ScrapeResult& result,
                  const ScraperConfig& cfg) {
        TagLib::MPEG::File f(filePath.c_str());
        if (!f.isValid()) {
            lastError_ = "无法打开 MP3 文件: " + filePath;
            return false;
        }
        
        TagLib::Tag* tag = f.tag();
        if (!tag) {
            lastError_ = "MP3 文件不支持标签写入";
            return false;
        }
        
        // 1. 写入基本元数据
        if (cfg.embedMetadata) {
            writeMetadata(tag, result);
        }
        
        // 2. 写入扩展元数据
        if (cfg.embedMetadata || (cfg.embedLyrics && result.lyrics)) {
            writeID3Extended(&f, result);
        }
        
        // 3. 写入封面
        if (cfg.embedCover && !result.coverData.empty()) {
            writeID3Cover(&f, result);
        }
        
        // 4. 保存文件
        if (!f.save()) {
            lastError_ = "保存 MP3 标签失败";
            return false;
        }
        
        return true;
    }
    
    /// 直接写入 FLAC 文件
    bool writeFlac(const std::string& filePath, const ScrapeResult& result,
                   const ScraperConfig& cfg) {
        TagLib::FLAC::File f(filePath.c_str());
        if (!f.isValid()) {
            lastError_ = "无法打开 FLAC 文件: " + filePath;
            return false;
        }
        
        TagLib::Tag* tag = f.tag();
        if (!tag) {
            lastError_ = "FLAC 文件不支持标签写入";
            return false;
        }
        
        // 1. 写入基本元数据
        if (cfg.embedMetadata) {
            writeMetadata(tag, result);
        }
        
        // 2. 写入扩展元数据
        if (cfg.embedMetadata || (cfg.embedLyrics && result.lyrics)) {
            writeXiphExtended(&f, result, true);
        }
        
        // 3. 写入封面
        if (cfg.embedCover && !result.coverData.empty()) {
            writeFLACCover(&f, result);
        }
        
        // 4. 保存文件
        if (!f.save()) {
            lastError_ = "保存 FLAC 标签失败";
            return false;
        }
        
        return true;
    }
    
    /// 直接写入 OGG/Opus 文件
    bool writeOgg(const std::string& filePath, const ScrapeResult& result,
                  const ScraperConfig& cfg) {
        std::string ext = filePath.substr(filePath.find_last_of('.') + 1);
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);
        
        bool isOpus = (ext == "opus");
        TagLib::File* filePtr = nullptr;
        
        if (isOpus) {
            filePtr = new TagLib::Ogg::Opus::File(filePath.c_str());
        } else {
            filePtr = new TagLib::Ogg::Vorbis::File(filePath.c_str());
        }
        
        if (!filePtr || !filePtr->isValid()) {
            delete filePtr;
            lastError_ = "无法打开 OGG/Opus 文件: " + filePath;
            return false;
        }
        
        TagLib::Tag* tag = filePtr->tag();
        if (!tag) {
            delete filePtr;
            lastError_ = "OGG/Opus 文件不支持标签写入";
            return false;
        }
        
        // 1. 写入基本元数据
        if (cfg.embedMetadata) {
            writeMetadata(tag, result);
        }
        
        // 2. 写入扩展元数据
        if (cfg.embedMetadata || (cfg.embedLyrics && result.lyrics)) {
            writeXiphExtended(filePtr, result, false);
        }
        
        // 3. 写入封面
        if (cfg.embedCover && !result.coverData.empty()) {
            writeVorbisCover(filePtr, result);
        }
        
        // 4. 保存文件
        if (!filePtr->save()) {
            delete filePtr;
            lastError_ = "保存 OGG/Opus 标签失败";
            return false;
        }
        
        delete filePtr;
        return true;
    }
    
    /// 直接写入 MP4/M4A/AAC 文件
    bool writeMp4(const std::string& filePath, const ScrapeResult& result,
                  const ScraperConfig& cfg) {
        TagLib::MP4::File f(filePath.c_str());
        if (!f.isValid()) {
            lastError_ = "无法打开 MP4/M4A 文件: " + filePath;
            return false;
        }
        
        TagLib::Tag* tag = f.tag();
        if (!tag) {
            lastError_ = "MP4/M4A 文件不支持标签写入";
            return false;
        }
        
        // 1. 写入基本元数据
        if (cfg.embedMetadata) {
            writeMetadata(tag, result);
        }
        
        // 2. 写入扩展元数据
        if (cfg.embedMetadata || (cfg.embedLyrics && result.lyrics)) {
            writeMP4Extended(&f, result);
        }
        
        // 3. 写入封面
        if (cfg.embedCover && !result.coverData.empty()) {
            writeMP4Cover(&f, result);
        }
        
        // 4. 保存文件
        if (!f.save()) {
            lastError_ = "保存 MP4/M4A 标签失败";
            return false;
        }
        
        return true;
    }
    
    /// 通用写入方法（回退方案）
    bool writeGeneric(const std::string& filePath, const ScrapeResult& result,
                      const ScraperConfig& cfg) {
        TagLib::FileRef f(filePath.c_str());
        if (f.isNull() || !f.file()) {
            lastError_ = "无法打开文件: " + filePath;
            return false;
        }
        
        TagLib::Tag* tag = f.tag();
        if (!tag) {
            lastError_ = "文件不支持标签写入";
            return false;
        }
        
        // 1. 写入基本元数据
        if (cfg.embedMetadata) {
            writeMetadata(tag, result);
        }
        
        // 2. 写入扩展元数据
        if (cfg.embedMetadata || (cfg.embedLyrics && result.lyrics)) {
            writeExtendedTags(f.file(), filePath, result);
        }
        
        // 3. 写入封面
        if (cfg.embedCover && !result.coverData.empty()) {
            writeCover(f.file(), filePath, result);
        }
        
        // 4. 保存文件
        if (!f.save()) {
            lastError_ = "保存标签失败";
            return false;
        }
        
        return true;
    }

    /// 写入基本元数据（标准 Tag 接口）
    void writeMetadata(TagLib::Tag* tag, const ScrapeResult& result) {
        if (result.title) tag->setTitle(TagLib::String(*result.title, TagLib::String::UTF8));
        if (result.artist) tag->setArtist(TagLib::String(*result.artist, TagLib::String::UTF8));
        if (result.album) tag->setAlbum(TagLib::String(*result.album, TagLib::String::UTF8));
        if (result.genre) tag->setGenre(TagLib::String(*result.genre, TagLib::String::UTF8));
        if (result.year) tag->setYear(*result.year);
        if (result.trackNumber) tag->setTrack(*result.trackNumber);
    }

    /// 写入扩展元数据（按文件类型分发）
    void writeExtendedTags(TagLib::File* file, const std::string& filePath, const ScrapeResult& result) {
        std::string ext = filePath.substr(filePath.find_last_of('.') + 1);
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

        if (ext == "mp3") {
            writeID3Extended(file, result);
        } else if (ext == "flac") {
            writeXiphExtended(file, result, true);
        } else if (ext == "ogg" || ext == "oga" || ext == "opus") {
            writeXiphExtended(file, result, false);
        } else if (ext == "m4a" || ext == "aac" || ext == "mp4") {
            writeMP4Extended(file, result);
        }
    }

    /// 写入 ID3v2 扩展标签（MP3）
    void writeID3Extended(TagLib::File* file, const ScrapeResult& result) {
        auto* mpegFile = dynamic_cast<TagLib::MPEG::File*>(file);
        if (!mpegFile) return;

        TagLib::ID3v2::Tag* id3v2 = mpegFile->ID3v2Tag(true);
        if (!id3v2) return;

        // 按条件移除现有扩展帧，避免覆盖时重复，同时保留用户已有的其他字段
        auto removeFramesIf = [&](const char* id) {
            auto frames = id3v2->frameList(id);
            for (auto* frame : frames) {
                id3v2->removeFrame(frame, true);
            }
        };
        if (result.albumArtist) removeFramesIf("TPE2");
        if (result.composer) removeFramesIf("TCOM");
        if (result.discNumber) removeFramesIf("TPOS");
        if (result.isrc) removeFramesIf("TSRC");
        if (result.lyrics) removeFramesIf("USLT");
        if (result.year) {
            removeFramesIf("TYER");
            removeFramesIf("TDRC");
        }

        // 单独处理 TXXX：只移除 MusicBrainz 相关的，保留用户自定义字段
        {
            auto frames = id3v2->frameList("TXXX");
            for (auto* frame : frames) {
                auto* txxx = dynamic_cast<TagLib::ID3v2::UserTextIdentificationFrame*>(frame);
                if (txxx) {
                    std::string desc = txxx->description().to8Bit(true);
                    if (desc.find("MusicBrainz") != std::string::npos ||
                        desc.find("musicbrainz") != std::string::npos) {
                        id3v2->removeFrame(frame, true);
                    }
                }
            }
        }

        // TPE2: 专辑艺术家
        if (result.albumArtist) {
            auto* frame = new TagLib::ID3v2::TextIdentificationFrame("TPE2", TagLib::String::UTF8);
            frame->setText(TagLib::String(*result.albumArtist, TagLib::String::UTF8));
            id3v2->addFrame(frame);
        }

        // TCOM: 作曲家
        if (result.composer) {
            auto* frame = new TagLib::ID3v2::TextIdentificationFrame("TCOM", TagLib::String::UTF8);
            frame->setText(TagLib::String(*result.composer, TagLib::String::UTF8));
            id3v2->addFrame(frame);
        }

        // TPOS: 碟片编号
        if (result.discNumber) {
            auto* frame = new TagLib::ID3v2::TextIdentificationFrame("TPOS", TagLib::String::UTF8);
            frame->setText(TagLib::String(std::to_string(*result.discNumber), TagLib::String::UTF8));
            id3v2->addFrame(frame);
        }

        // TSRC: ISRC
        if (result.isrc) {
            auto* frame = new TagLib::ID3v2::TextIdentificationFrame("TSRC", TagLib::String::Latin1);
            frame->setText(TagLib::String(*result.isrc, TagLib::String::Latin1));
            id3v2->addFrame(frame);
        }

        // TXXX: MusicBrainz 标识符
        if (result.mbid) {
            addTxxxFrame(id3v2, "MusicBrainz Recording Id", *result.mbid);
        }
        if (result.albumMbid) {
            addTxxxFrame(id3v2, "MusicBrainz Album Id", *result.albumMbid);
        }
        if (result.artistMbid) {
            addTxxxFrame(id3v2, "MusicBrainz Artist Id", *result.artistMbid);
        }

        // USLT: 歌词
        if (result.lyrics) {
            auto* uslt = new TagLib::ID3v2::UnsynchronizedLyricsFrame();
            uslt->setLanguage(TagLib::ByteVector("XXX", 3));
            uslt->setText(TagLib::String(*result.lyrics, TagLib::String::UTF8));
            id3v2->addFrame(uslt);
        }
    }

    /// 添加 TXXX（用户定义文本）帧
    void addTxxxFrame(TagLib::ID3v2::Tag* id3v2, const std::string& description, const std::string& value) {
        auto* frame = new TagLib::ID3v2::UserTextIdentificationFrame(TagLib::String::UTF8);
        frame->setDescription(TagLib::String(description, TagLib::String::UTF8));
        frame->setText(TagLib::String(value, TagLib::String::UTF8));
        id3v2->addFrame(frame);
    }

    /// 写入 Xiph Comment 扩展标签（FLAC/OGG）
    void writeXiphExtended(TagLib::File* file, const ScrapeResult& result, bool isFlac) {
        TagLib::Ogg::XiphComment* vc = nullptr;

        if (isFlac) {
            auto* flacFile = dynamic_cast<TagLib::FLAC::File*>(file);
            if (flacFile) vc = flacFile->xiphComment(true);
        } else {
            auto* vorbisFile = dynamic_cast<TagLib::Ogg::Vorbis::File*>(file);
            if (vorbisFile) {
                vc = vorbisFile->tag();
            } else {
                auto* opusFile = dynamic_cast<TagLib::Ogg::Opus::File*>(file);
                if (opusFile) vc = opusFile->tag();
            }
        }

        if (!vc) return;

        // 专辑艺术家
        if (result.albumArtist) {
            vc->addField("ALBUMARTIST", TagLib::String(*result.albumArtist, TagLib::String::UTF8), true);
        }
        // 作曲家
        if (result.composer) {
            vc->addField("COMPOSER", TagLib::String(*result.composer, TagLib::String::UTF8), true);
        }
        // 碟片编号
        if (result.discNumber) {
            vc->addField("DISCNUMBER", TagLib::String(std::to_string(*result.discNumber), TagLib::String::UTF8), true);
        }
        // ISRC
        if (result.isrc) {
            vc->addField("ISRC", TagLib::String(*result.isrc, TagLib::String::Latin1), true);
        }
        // MusicBrainz 标识符
        if (result.mbid) {
            vc->addField("MUSICBRAINZ_RECORDINGID", TagLib::String(*result.mbid, TagLib::String::UTF8), true);
        }
        if (result.albumMbid) {
            vc->addField("MUSICBRAINZ_ALBUMID", TagLib::String(*result.albumMbid, TagLib::String::UTF8), true);
        }
        if (result.artistMbid) {
            vc->addField("MUSICBRAINZ_ARTISTID", TagLib::String(*result.artistMbid, TagLib::String::UTF8), true);
        }
        // 歌词
        if (result.lyrics) {
            vc->addField("LYRICS", TagLib::String(*result.lyrics, TagLib::String::UTF8), true);
        }
    }

    /// 写入 MP4 扩展标签（M4A/AAC/MP4）
    void writeMP4Extended(TagLib::File* file, const ScrapeResult& result) {
        auto* mp4File = dynamic_cast<TagLib::MP4::File*>(file);
        if (!mp4File) return;

        TagLib::MP4::Tag* mp4Tag = mp4File->tag();
        if (!mp4Tag) return;

        // aART: 专辑艺术家
        if (result.albumArtist) {
            mp4Tag->setItem("aART", TagLib::MP4::Item(
                TagLib::StringList(TagLib::String(*result.albumArtist, TagLib::String::UTF8))));
        }
        // ©wrt: 作曲家
        if (result.composer) {
            mp4Tag->setItem("\251wrt", TagLib::MP4::Item(
                TagLib::StringList(TagLib::String(*result.composer, TagLib::String::UTF8))));
        }
        // disk: 碟片编号
        if (result.discNumber) {
            mp4Tag->setItem("disk", TagLib::MP4::Item(
                static_cast<int>(*result.discNumber), 0));
        }
        // ©lyr: 歌词
        if (result.lyrics) {
            mp4Tag->setItem("\251lyr", TagLib::MP4::Item(
                TagLib::StringList(TagLib::String(*result.lyrics, TagLib::String::UTF8))));
        }
        // ----: MusicBrainz 标识符（freeform）
        if (result.mbid) {
            mp4Tag->setItem("----com.apple.iTunes:MusicBrainz Track Id",
                TagLib::MP4::Item(TagLib::StringList(
                    TagLib::String(*result.mbid, TagLib::String::UTF8))));
        }
        if (result.isrc) {
            mp4Tag->setItem("----com.apple.iTunes:ISRC",
                TagLib::MP4::Item(TagLib::StringList(
                    TagLib::String(*result.isrc, TagLib::String::UTF8))));
        }
    }

    /// 写入封面图片
    void writeCover(TagLib::File* file, const std::string& filePath, const ScrapeResult& result) {
        std::string ext = filePath.substr(filePath.find_last_of('.') + 1);
        std::transform(ext.begin(), ext.end(), ext.begin(), ::tolower);

        if (ext == "mp3") {
            writeID3Cover(file, result);
        } else if (ext == "flac") {
            writeFLACCover(file, result);
        } else if (ext == "ogg" || ext == "oga" || ext == "opus") {
            writeVorbisCover(file, result);
        } else if (ext == "m4a" || ext == "aac" || ext == "mp4") {
            writeMP4Cover(file, result);
        }
    }

    /// 写入 ID3v2 封面（MP3）
    void writeID3Cover(TagLib::File* file, const ScrapeResult& result) {
        auto* mpegFile = dynamic_cast<TagLib::MPEG::File*>(file);
        if (!mpegFile) return;

        TagLib::ID3v2::Tag* id3v2 = mpegFile->ID3v2Tag(true);
        if (!id3v2) return;

        // 移除现有封面
        auto frames = id3v2->frameList("APIC");
        for (auto* frame : frames) {
            id3v2->removeFrame(frame, true);
        }

        auto* picFrame = new TagLib::ID3v2::AttachedPictureFrame();
        picFrame->setType(TagLib::ID3v2::AttachedPictureFrame::FrontCover);
        picFrame->setMimeType(TagLib::String(result.coverMime, TagLib::String::Latin1));
        picFrame->setDescription(TagLib::String("Front Cover", TagLib::String::UTF8));
        picFrame->setPicture(TagLib::ByteVector(
            reinterpret_cast<const char*>(result.coverData.data()),
            result.coverData.size()
        ));
        id3v2->addFrame(picFrame);
    }

    /// 写入 FLAC 封面
    void writeFLACCover(TagLib::File* file, const ScrapeResult& result) {
        auto* flacFile = dynamic_cast<TagLib::FLAC::File*>(file);
        if (!flacFile) return;

        auto pictures = flacFile->pictureList();
        for (auto* pic : pictures) {
            flacFile->removePicture(pic, true);
        }

        auto* picture = new TagLib::FLAC::Picture();
        picture->setType(TagLib::FLAC::Picture::FrontCover);
        picture->setMimeType(TagLib::String(result.coverMime, TagLib::String::Latin1));
        picture->setDescription(TagLib::String("Front Cover", TagLib::String::UTF8));
        picture->setData(TagLib::ByteVector(
            reinterpret_cast<const char*>(result.coverData.data()),
            result.coverData.size()
        ));
        flacFile->addPicture(picture);
    }

    /// 写入 Vorbis 封面（OGG/Opus）
    void writeVorbisCover(TagLib::File* file, const ScrapeResult& result) {
        TagLib::Ogg::XiphComment* vc = nullptr;

        auto* vorbisFile = dynamic_cast<TagLib::Ogg::Vorbis::File*>(file);
        if (vorbisFile) {
            vc = vorbisFile->tag();
        } else {
            // 尝试 Opus
            auto* opusFile = dynamic_cast<TagLib::Ogg::Opus::File*>(file);
            if (opusFile) vc = opusFile->tag();
        }

        if (!vc) return;

        // 移除已有封面
        auto existingPics = vc->pictureList();
        for (auto* pic : existingPics) {
            vc->removePicture(pic, true);
        }

        // Vorbis Comment 封面以 METADATA_BLOCK_PICTURE 存储
        auto* picture = new TagLib::FLAC::Picture();
        picture->setType(TagLib::FLAC::Picture::FrontCover);
        picture->setMimeType(TagLib::String(result.coverMime, TagLib::String::Latin1));
        picture->setDescription(TagLib::String("Front Cover", TagLib::String::UTF8));
        picture->setData(TagLib::ByteVector(
            reinterpret_cast<const char*>(result.coverData.data()),
            result.coverData.size()
        ));

        vc->addPicture(picture);
    }

    /// 写入 MP4 封面（M4A/AAC/MP4）
    void writeMP4Cover(TagLib::File* file, const ScrapeResult& result) {
        auto* mp4File = dynamic_cast<TagLib::MP4::File*>(file);
        if (!mp4File) return;

        TagLib::MP4::Tag* mp4Tag = mp4File->tag();
        if (!mp4Tag) return;

        TagLib::MP4::CoverArt::Format format = TagLib::MP4::CoverArt::JPEG;
        if (result.coverMime == "image/png") {
            format = TagLib::MP4::CoverArt::PNG;
        }

        TagLib::MP4::CoverArt coverArt(format, TagLib::ByteVector(
            reinterpret_cast<const char*>(result.coverData.data()),
            result.coverData.size()
        ));
        TagLib::MP4::CoverArtList coverArtList;
        coverArtList.append(coverArt);
        mp4Tag->setItem("covr", coverArtList);
    }

    std::string lastError_;
};

} // namespace splayer::scraper
